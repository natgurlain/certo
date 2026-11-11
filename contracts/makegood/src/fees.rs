//! Fee tiers, ruling stakes, buyer record and the settlement table (DESIGN 4.2, 4.5).
use crate::consts::FEE_BPS;
use crate::{BuyerRec, Seller};

/// `max(1, ceil(amount × FEE_BPS[idx] / 10000))`.
pub fn fee_for(amount: u128, fee_idx: u8) -> u128 {
    let bps = FEE_BPS[fee_idx as usize] as u128;
    (amount * bps).div_ceil(10_000).max(1)
}

/// Base ruling stake: `max(stake_min, price × stake_bps / 10000)` (multiplier 1).
pub fn stake_for(price: u128, stake_min: u128, stake_bps: u16) -> u128 {
    (price * stake_bps as u128 / 10_000).max(stake_min)
}

/// Stake a buyer must post to open a dispute.
pub fn required_stake(base: u128, buyer: &BuyerRec) -> u128 {
    base << buyer.stake_mult_log2
}

/// A refund forced on the seller. Returns `(old_idx, new_idx)` if the tier changed.
pub fn on_seller_loss(s: &mut Seller, refund: u128) -> Option<(u8, u8)> {
    let old = s.fee_idx;
    s.fee_idx = (s.fee_idx + 1).min(4);
    s.lifetime_losses += 1;
    s.recovery_volume = s.recovery_volume.max(50 * refund);
    s.clean_calls_since_step = 0;
    s.clean_volume_since_step = 0;
    (old != s.fee_idx).then_some((old, s.fee_idx))
}

/// Called for each released (clean) call after the counters were bumped.
/// Returns `(old_idx, new_idx)` on a step down.
pub fn on_release(s: &mut Seller) -> Option<(u8, u8)> {
    if s.clean_calls_since_step < 20 || s.clean_volume_since_step < s.recovery_volume {
        return None;
    }
    let old = s.fee_idx;
    let new = if old > 1 {
        old - 1
    } else if old == 1 && s.lifetime_calls >= 500 && (s.lifetime_losses as u64) * 200 <= s.lifetime_calls {
        0
    } else {
        return None;
    };
    s.fee_idx = new;
    s.clean_calls_since_step = 0;
    s.clean_volume_since_step = 0;
    s.recovery_volume = 0;
    Some((old, new))
}

pub fn buyer_won(b: &mut BuyerRec) {
    b.disputes_won += 1;
    b.stake_mult_log2 = b.stake_mult_log2.saturating_sub(1);
}

pub fn buyer_lost(b: &mut BuyerRec) {
    b.disputes_lost += 1;
    b.stake_mult_log2 = (b.stake_mult_log2 + 1).min(4);
}

/// Money movements of one panel settlement (DESIGN 4.2 settlement table).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Settlement {
    pub refund: u128,
    pub to_buyer: u128,
    pub bond_debit: u128,
    pub treasury_credit: u128,
}

/// `price` p, `stake` s (as paid), `base_stake` s0, chosen offer in bps.
pub fn settle_panel(price: u128, stake: u128, base_stake: u128, offer_bps: u16, buyer_wins: bool) -> Settlement {
    let refund = price * offer_bps as u128 / 10_000;
    if buyer_wins {
        Settlement { refund, to_buyer: refund + stake, bond_debit: refund + base_stake, treasury_credit: base_stake }
    } else {
        Settlement { refund, to_buyer: refund, bond_debit: refund, treasury_credit: stake }
    }
}

/// Midpoint of two offers, rounded down to a whole percent.
pub fn midpoint_bps(a: u16, b: u16) -> u16 {
    ((a as u32 + b as u32) / 2 / 100 * 100) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seller() -> Seller {
        Seller::new([0; 32], 120_000)
    }

    #[test]
    fn fee_rounding() {
        assert_eq!(fee_for(400_000, 1), 4_000);
        assert_eq!(fee_for(400_000, 2), 6_000);
        assert_eq!(fee_for(400_001, 1), 4_001); // ceil
        assert_eq!(fee_for(1, 0), 1); // floor of 1
        assert_eq!(fee_for(10_000, 4), 500);
    }

    #[test]
    fn stake_and_multiplier() {
        assert_eq!(stake_for(400_000, 20_000, 500), 20_000);
        assert_eq!(stake_for(1_000_000, 20_000, 500), 50_000);
        let mut b = BuyerRec::default();
        assert_eq!(required_stake(20_000, &b), 20_000);
        buyer_lost(&mut b);
        assert_eq!(required_stake(20_000, &b), 40_000);
        for _ in 0..10 {
            buyer_lost(&mut b);
        }
        assert_eq!(required_stake(20_000, &b), 320_000); // cap 16x
        buyer_won(&mut b);
        assert_eq!(required_stake(20_000, &b), 160_000);
        assert_eq!((b.disputes_won, b.disputes_lost), (1, 11));
    }

    #[test]
    fn step_up_and_cap() {
        let mut s = seller();
        assert_eq!(s.fee_idx, 1);
        assert_eq!(on_seller_loss(&mut s, 400_000), Some((1, 2)));
        assert_eq!(s.recovery_volume, 20_000_000);
        on_seller_loss(&mut s, 100);
        assert_eq!(s.recovery_volume, 20_000_000); // max, not overwrite
        on_seller_loss(&mut s, 100);
        assert_eq!(on_seller_loss(&mut s, 100), None); // already 4
        assert_eq!(s.fee_idx, 4);
        assert_eq!(s.lifetime_losses, 4);
    }

    fn release(s: &mut Seller, price: u128) -> Option<(u8, u8)> {
        s.lifetime_calls += 1;
        s.lifetime_volume += price;
        s.clean_calls_since_step += 1;
        s.clean_volume_since_step += price;
        on_release(s)
    }

    #[test]
    fn step_down_needs_calls_and_volume() {
        let mut s = seller();
        on_seller_loss(&mut s, 400_000); // tier 2, recovery 20.00
        // 20 calls of 0.01 do not wash a 0.40 loss
        for _ in 0..20 {
            assert_eq!(release(&mut s, 10_000), None);
        }
        assert_eq!(s.fee_idx, 2);
        // volume reaches 20.00 after 50 calls of 0.40 in total from the step
        let mut n = 0;
        while release(&mut s, 400_000).is_none() {
            n += 1;
        }
        assert_eq!(s.fee_idx, 1);
        assert_eq!(n + 1, 50);
        assert_eq!(s.recovery_volume, 0);
        // At tier 1 a step down needs the tier-0 condition
        for _ in 0..100 {
            assert_eq!(release(&mut s, 400_000), None);
        }
        assert_eq!(s.fee_idx, 1);
    }

    #[test]
    fn tier_zero_after_500_clean_calls() {
        let mut s = seller();
        let mut stepped_at = None;
        for i in 1..=600u64 {
            if release(&mut s, 400_000).is_some() {
                stepped_at.get_or_insert(i);
            }
        }
        assert_eq!(stepped_at, Some(500));
        assert_eq!(s.fee_idx, 0);
        // never below 0
        assert_eq!(on_release(&mut s), None);
    }

    #[test]
    fn tier_zero_blocked_by_loss_ratio() {
        let mut s = seller();
        s.lifetime_losses = 3; // 3 × 200 = 600 > 500
        for _ in 0..500 {
            release(&mut s, 1);
        }
        assert_eq!(s.fee_idx, 1);
    }

    #[test]
    fn settlement_table() {
        // p = 0.40, s = 0.04 (2x), s0 = 0.02, buyer's offer 100% wins
        let b = settle_panel(400_000, 40_000, 20_000, 10_000, true);
        assert_eq!(b, Settlement { refund: 400_000, to_buyer: 440_000, bond_debit: 420_000, treasury_credit: 20_000 });
        // seller's offer 25% wins
        let s = settle_panel(400_000, 40_000, 20_000, 2_500, false);
        assert_eq!(s, Settlement { refund: 100_000, to_buyer: 100_000, bond_debit: 100_000, treasury_credit: 40_000 });
        // seller's offer 0 wins
        let z = settle_panel(400_000, 20_000, 20_000, 0, false);
        assert_eq!(z.to_buyer, 0);
        // conservation: what leaves the bond + stake equals buyer + treasury
        for (st, w) in [(b, true), (s, false), (z, false)] {
            let stake = if w { 40_000 } else if st.treasury_credit == 40_000 { 40_000 } else { 20_000 };
            assert_eq!(st.bond_debit + stake, st.to_buyer + st.treasury_credit);
        }
        // never more than reserve = p + s0
        assert!(b.bond_debit <= 400_000 + 20_000);
    }

    #[test]
    fn midpoint_rounds_down_to_percent() {
        assert_eq!(midpoint_bps(10_000, 0), 5_000);
        assert_eq!(midpoint_bps(10_000, 100), 5_000);
        assert_eq!(midpoint_bps(300, 0), 100);
        assert_eq!(midpoint_bps(0, 0), 0);
    }
}
