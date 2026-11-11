//! Lazy window expiry: a per-seller FIFO of `(expires_at_ms, call_id)` swept at
//! the start of `pay`, `withdraw_bond`, `release`, and simulated in views (DESIGN 4.2).
use crate::consts::SWEEP_MAX;
use crate::{events, fees, CallStatus, Contract, ContractExt, QueueItem, Seller};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};
use serde_json::json;

enum Step {
    Drop,
    Release,
    Stop,
}

impl Contract {
    fn classify(&self, item: &QueueItem, now: u64) -> Step {
        match self.calls.get(&item.call_id) {
            None => Step::Drop,
            Some(c) if c.status != CallStatus::Open || c.expires_at_ms != item.expires_at_ms => Step::Drop,
            Some(_) if item.expires_at_ms > now => Step::Stop,
            Some(_) => Step::Release,
        }
    }

    pub(crate) fn enqueue(&mut self, seller_id: &AccountId, s: &mut Seller, expires_at_ms: u64, call_id: String) {
        self.queue.insert((seller_id.clone(), s.q_tail), QueueItem { expires_at_ms, call_id });
        s.q_tail += 1;
    }

    /// Walk at most `max` items from the head. Returns the number of items consumed.
    pub(crate) fn sweep(&mut self, seller_id: &AccountId, s: &mut Seller, max: u32) -> u32 {
        let now = env::block_timestamp_ms();
        let mut n = 0;
        while n < max && s.q_head < s.q_tail {
            let key = (seller_id.clone(), s.q_head);
            if let Some(item) = self.queue.get(&key).cloned() {
                match self.classify(&item, now) {
                    Step::Stop => break,
                    Step::Drop => {}
                    Step::Release => self.release_call(seller_id, s, &item.call_id),
                }
            }
            self.queue.remove(&key);
            s.q_head += 1;
            n += 1;
        }
        n
    }

    fn release_call(&mut self, seller_id: &AccountId, s: &mut Seller, call_id: &str) {
        let c = self.calls.remove(call_id).expect("checked by classify");
        s.reserved -= c.reserve;
        s.lifetime_calls += 1;
        s.lifetime_volume += c.price;
        s.clean_calls_since_step += 1;
        s.clean_volume_since_step += c.price;
        events::emit(
            "call_released",
            json!({ "call_id": call_id, "seller": seller_id, "buyer": c.buyer, "price": U128(c.price) }),
        );
        if let Some((from, to)) = fees::on_release(s) {
            Self::emit_fee_change(seller_id, from, to);
        }
    }

    /// Reserve that a sweep would free now (read-only; used by views).
    pub(crate) fn sweep_preview(&self, seller_id: &AccountId, s: &Seller) -> u128 {
        let now = env::block_timestamp_ms();
        let mut freed = 0;
        let mut i = s.q_head;
        while i < s.q_tail && i - s.q_head < SWEEP_MAX as u64 {
            if let Some(item) = self.queue.get(&(seller_id.clone(), i)) {
                match self.classify(item, now) {
                    Step::Stop => break,
                    Step::Drop => {}
                    Step::Release => freed += self.calls.get(&item.call_id).map(|c| c.reserve).unwrap_or(0),
                }
            }
            i += 1;
        }
        freed
    }

    pub(crate) fn emit_fee_change(seller_id: &AccountId, from: u8, to: u8) {
        events::emit(
            "fee_tier_changed",
            json!({
                "seller": seller_id, "from_idx": from, "to_idx": to,
                "fee_bps": crate::consts::FEE_BPS[to as usize],
            }),
        );
    }
}

#[near]
impl Contract {
    /// Anyone: sweep up to `min(max, SWEEP_MAX)` queue items of `seller`. Returns items consumed.
    pub fn release(&mut self, seller: AccountId, max: Option<u32>) -> u32 {
        let mut s = self.seller(&seller);
        let n = self.sweep(&seller, &mut s, max.unwrap_or(SWEEP_MAX).min(SWEEP_MAX));
        self.sellers.insert(seller, s);
        n
    }
}
