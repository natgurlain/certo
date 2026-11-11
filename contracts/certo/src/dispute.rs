//! Rule tier, dispute opening, seller answer/cure and timeout defaults (DESIGN 4.2, 4.3).
use crate::consts::MAX_CURE_BODY;
use crate::encode::{commit_preimage, receipt_text, to_hex};
use crate::{events, fail, fees, hex32, sig64, Call, CallStatus, Contract, ContractExt, Dispute, Seller, Terms};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{env, near, require, AccountId};
use serde_json::json;

/// First rule the response breaks, as the `reason` string, or `None` (DESIGN 4.2 `claim_rule`).
/// The `as_of_field` must hold an integer of Unix seconds; absent or non-integer counts as missing.
pub fn broken_rule(terms: &Terms, body: &str, served_at_ms: u64) -> Option<String> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Some("not_json".into()),
    };
    for f in &terms.required_fields {
        if v.get(f).is_none() {
            return Some(format!("missing_field:{}", f));
        }
    }
    if let (Some(field), Some(max_age)) = (&terms.as_of_field, terms.max_age_s) {
        let Some(as_of) = v.get(field).and_then(|x| x.as_u64()) else {
            return Some(format!("missing_field:{}", field));
        };
        let age = (served_at_ms / 1000).saturating_sub(as_of);
        if age > max_age as u64 {
            return Some(format!("stale:{}", age));
        }
    }
    None
}

#[near]
impl Contract {
    /// Buyer: full refund on a seller-signed receipt with HTTP status ≥ 500.
    pub fn claim_error(
        &mut self,
        call_id: String,
        response_hash: String,
        status_code: u16,
        served_at_ms: u64,
        sig: Base64VecU8,
    ) {
        let c = self.call(&call_id);
        self.check_buyer_open_in_window(&c);
        require!(status_code >= 500, "E_HTTP_STATUS");
        self.check_receipt(&call_id, &c, &hex32(&response_hash), status_code, served_at_ms, &sig);
        self.rule_refund(&call_id, c, "seller_error".into(), false);
    }

    /// Buyer (SHOULD S3): full refund when the delivered body breaks a published rule of the terms.
    pub fn claim_rule(
        &mut self,
        call_id: String,
        response_hash: String,
        status_code: u16,
        served_at_ms: u64,
        sig: Base64VecU8,
        response_body: String,
    ) {
        let c = self.call(&call_id);
        self.check_buyer_open_in_window(&c);
        require!(status_code < 500, "E_HTTP_STATUS");
        require!(response_body.len() <= MAX_CURE_BODY, "E_EVIDENCE_SIZE");
        let rh = hex32(&response_hash);
        require!(env::sha256_array(response_body.as_bytes()) == rh, "E_EVIDENCE_HASH");
        self.check_receipt(&call_id, &c, &rh, status_code, served_at_ms, &sig);
        let terms = self.terms.get(&(c.seller.clone(), c.terms_id.clone())).cloned().unwrap_or_else(|| fail("E_TERMS"));
        let reason = broken_rule(&terms, &response_body, served_at_ms).unwrap_or_else(|| fail("E_RULE_NOT_BROKEN"));
        self.rule_refund(&call_id, c, reason, false);
    }

    /// Seller: answer a content dispute with a refund offer (whole percent, in bps).
    pub fn answer(&mut self, call_id: String, offer_bps: u16) {
        let mut c = self.call(&call_id);
        require!(env::predecessor_account_id() == c.seller, "E_NOT_SELLER");
        require!(c.status == CallStatus::Disputed, "E_STATUS");
        let now = env::block_timestamp_ms();
        let d = c.dispute.as_mut().expect("disputed");
        require!(now <= d.opened_at_ms + self.cfg.answer_ms, "E_ANSWER_LATE");
        require!(offer_bps <= 10_000 && offer_bps % 100 == 0, "E_OFFER_RANGE");
        d.seller_offer_bps = Some(offer_bps);
        d.answered_at_ms = now;
        c.status = CallStatus::Answered;
        self.calls.insert(call_id.clone(), c);
        events::emit("dispute_answered", json!({ "call_id": call_id, "seller_offer_bps": offer_bps }));
    }

    /// Seller: publish the response and a valid receipt to cure a non-delivery claim.
    pub fn cure(
        &mut self,
        call_id: String,
        response_hash: String,
        status_code: u16,
        served_at_ms: u64,
        sig: Base64VecU8,
        response_body: String,
    ) {
        let mut c = self.call(&call_id);
        require!(env::predecessor_account_id() == c.seller, "E_NOT_SELLER");
        require!(c.status == CallStatus::NonDeliveryClaimed, "E_STATUS");
        let now = env::block_timestamp_ms();
        let d = c.dispute.clone().expect("claimed");
        require!(now <= d.opened_at_ms + self.cfg.answer_ms, "E_ANSWER_LATE");
        require!(response_body.len() <= MAX_CURE_BODY, "E_EVIDENCE_SIZE");
        let rh = hex32(&response_hash);
        require!(env::sha256_array(response_body.as_bytes()) == rh, "E_EVIDENCE_HASH");
        self.check_receipt(&call_id, &c, &rh, status_code, served_at_ms, &sig);
        if status_code >= 500 {
            self.rule_refund(&call_id, c, "seller_error".into(), false);
            return;
        }
        let mut s = self.seller(&c.seller);
        s.disputed_reserved -= c.reserve;
        s.reserved += c.reserve;
        c.status = CallStatus::Open;
        c.expires_at_ms = now + s.window_ms;
        c.dispute = None;
        let (buyer, seller_id, expires) = (c.buyer.clone(), c.seller.clone(), c.expires_at_ms);
        self.calls.insert(call_id.clone(), c);
        self.enqueue(&seller_id, &mut s, expires, call_id.clone());
        self.sellers.insert(seller_id, s);
        self.pay_out(&buyer, d.stake);
        events::emit(
            "cured",
            json!({
                "call_id": call_id, "response_hash": response_hash, "status_code": status_code,
                "expires_at_ms": expires, "stake_returned": U128(d.stake),
            }),
        );
    }

    /// Anyone, after a timeout: (a) seller did not answer/cure → full refund by rule;
    /// (b) answered but no panel verdict by the deadline → the seller's offer (or the buyer's,
    /// if lower); the stake is returned with a valid reveal, else it goes to the treasury.
    /// A missing verdict never pays the buyer more than the seller offered (guard G16): only
    /// the buyer holds its reveal, and it can always force a verdict itself with `resolve`
    /// (open to anyone after `resolver_exclusive_ms`), so withholding the reveal from the
    /// panel must not pay.
    pub fn resolve_default(&mut self, call_id: String, buyer_offer_bps: Option<u16>, salt: Option<String>) {
        let c = self.call(&call_id);
        let d = c.dispute.clone().unwrap_or_else(|| fail("E_STATUS"));
        let now = env::block_timestamp_ms();
        match c.status {
            CallStatus::NonDeliveryClaimed | CallStatus::Disputed => {
                require!(now > d.opened_at_ms + self.cfg.answer_ms, "E_TOO_EARLY");
                self.rule_refund(&call_id, c, "seller_no_answer".into(), true);
            }
            CallStatus::Answered => {
                require!(now > d.answered_at_ms + self.cfg.panel_deadline_ms, "E_TOO_EARLY");
                let seller_bps = d.seller_offer_bps.expect("answered");
                let revealed = match (buyer_offer_bps, salt) {
                    (Some(b), Some(salt)) => {
                        self.check_reveal(&d, b, &salt);
                        Some(b)
                    }
                    _ => None,
                };
                let (bps, reason) = match revealed {
                    Some(b) if seller_bps >= b => (b, "settled"),
                    #[cfg(feature = "no_g16")]
                    Some(b) => (fees::midpoint_bps(b, seller_bps), "midpoint"),
                    #[cfg(not(feature = "no_g16"))]
                    Some(_) => (seller_bps, "seller_offer"),
                    None => (seller_bps, "no_reveal"),
                };
                let refund = c.price * bps as u128 / 10_000;
                let mut s = self.seller(&c.seller);
                s.bond -= refund;
                s.disputed_reserved -= c.reserve;
                let to_buyer = if revealed.is_some() {
                    refund + d.stake
                } else {
                    self.treasury += d.stake;
                    refund
                };
                self.sellers.insert(c.seller.clone(), s);
                self.calls.remove(&call_id);
                self.pay_out(&c.buyer, to_buyer);
                events::emit(
                    "dispute_resolved",
                    json!({
                        "call_id": call_id, "tier": "default", "reason": reason, "refund": U128(refund),
                        "refund_bps": bps, "to_buyer": U128(to_buyer),
                        "stake_forfeited": U128(if revealed.is_some() { 0 } else { d.stake }),
                    }),
                );
            }
            CallStatus::Open => fail("E_STATUS"),
        }
    }
}

impl Contract {
    fn check_buyer_open_in_window(&self, c: &Call) {
        require!(env::predecessor_account_id() == c.buyer, "E_NOT_BUYER");
        require!(c.status == CallStatus::Open, "E_STATUS");
        self.check_window(c);
    }

    pub(crate) fn check_window(&self, c: &Call) {
        #[cfg(not(feature = "no_g4"))]
        require!(env::block_timestamp_ms() <= c.expires_at_ms, "E_WINDOW_CLOSED");
        let _ = c;
    }

    /// Rebuild the receipt text from the call and check the seller's ed25519 signature (G5).
    pub(crate) fn check_receipt(
        &self,
        call_id: &str,
        c: &Call,
        response_hash: &[u8; 32],
        status_code: u16,
        served_at_ms: u64,
        sig: &Base64VecU8,
    ) {
        let sig = sig64(sig);
        let text = receipt_text(
            env::current_account_id().as_str(),
            call_id,
            c.buyer.as_str(),
            c.price,
            &c.terms_id,
            &c.request_hash,
            response_hash,
            status_code,
            served_at_ms,
        );
        let key = self.seller(&c.seller).receipt_pubkey;
        #[cfg(not(feature = "no_g5"))]
        require!(env::ed25519_verify(&sig, text.as_bytes(), &key), "E_BAD_RECEIPT_SIG");
        let _ = (sig, text, key);
    }

    pub(crate) fn check_reveal(&self, d: &Dispute, offer_bps: u16, salt: &str) {
        require!(offer_bps <= 10_000 && offer_bps % 100 == 0, "E_OFFER_RANGE");
        let salt = hex32(salt);
        require!(env::sha256_array(commit_preimage(offer_bps, &salt)) == d.buyer_commit, "E_COMMIT_MISMATCH");
    }

    /// Full refund of the price from the bond; the buyer's stake (if any) is returned.
    /// `ruling_fee`: the seller also pays the base ruling stake to the treasury (no-answer default).
    fn rule_refund(&mut self, call_id: &str, c: Call, reason: String, ruling_fee: bool) {
        let mut s = self.seller(&c.seller);
        let stake = c.dispute.as_ref().map(|d| d.stake).unwrap_or(0);
        let fee = if ruling_fee { self.base_stake(c.price) } else { 0 };
        s.bond -= c.price + fee;
        if c.status == CallStatus::Open {
            s.reserved -= c.reserve;
        } else {
            s.disputed_reserved -= c.reserve;
        }
        self.treasury += fee;
        self.record_seller_loss(&c.seller, &mut s, c.price);
        if c.dispute.is_some() {
            let mut b = self.buyer_rec(&c.buyer);
            fees::buyer_won(&mut b);
            self.buyers.insert(c.buyer.clone(), b);
        }
        self.sellers.insert(c.seller.clone(), s);
        self.calls.remove(call_id);
        self.pay_out(&c.buyer, c.price + stake);
        events::emit(
            "dispute_resolved",
            json!({
                "call_id": call_id, "tier": "rule", "reason": reason, "refund": U128(c.price),
                "ruling_fee": U128(fee), "stake_returned": U128(stake),
            }),
        );
    }

    pub(crate) fn record_seller_loss(&mut self, seller_id: &AccountId, s: &mut Seller, refund: u128) {
        if let Some((from, to)) = fees::on_seller_loss(s, refund) {
            Self::emit_fee_change(seller_id, from, to);
        }
    }

    /// Dispute opening via `ft_transfer_call` (`amount` is the stake).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn on_dispute(
        &mut self,
        sender: AccountId,
        amount: u128,
        kind: String,
        call_id: String,
        response_hash: Option<String>,
        status_code: Option<u16>,
        served_at_ms: Option<u64>,
        sig: Option<Base64VecU8>,
        offer_commit: Option<String>,
    ) {
        let mut c = self.call(&call_id);
        require!(sender == c.buyer, "E_NOT_BUYER");
        #[cfg(not(feature = "no_g3"))]
        require!(c.status == CallStatus::Open, "E_STATUS");
        self.check_window(&c);
        let need = fees::required_stake(self.base_stake(c.price), &self.buyer_rec(&sender));
        require!(amount >= need, "E_STAKE_LOW");
        let now = env::block_timestamp_ms();
        let mut d = Dispute {
            opened_at_ms: now,
            stake: amount,
            buyer_commit: [0; 32],
            response_hash: [0; 32],
            status_code: 0,
            served_at_ms: 0,
            seller_offer_bps: None,
            answered_at_ms: 0,
        };
        let new_status = match kind.as_str() {
            "non_delivery" => CallStatus::NonDeliveryClaimed,
            "content" => {
                let (Some(rh), Some(code), Some(served), Some(sig), Some(commit)) =
                    (response_hash, status_code, served_at_ms, sig, offer_commit)
                else {
                    fail("E_BAD_ARGS")
                };
                require!(code < 500, "E_HTTP_STATUS");
                let terms = self.terms.get(&(c.seller.clone(), c.terms_id.clone()));
                require!(terms.map(|t| t.panel).unwrap_or(false), "E_NO_PANEL_TERMS");
                let rh = hex32(&rh);
                self.check_receipt(&call_id, &c, &rh, code, served, &sig);
                d.response_hash = rh;
                d.status_code = code;
                d.served_at_ms = served;
                d.buyer_commit = hex32(&commit);
                CallStatus::Disputed
            }
            _ => fail("E_BAD_ARGS"),
        };
        if c.status == CallStatus::Open {
            let mut s = self.seller(&c.seller);
            s.reserved -= c.reserve;
            s.disputed_reserved += c.reserve;
            self.sellers.insert(c.seller.clone(), s);
        }
        let response_hash = (new_status == CallStatus::Disputed).then(|| to_hex(&d.response_hash));
        c.status = new_status;
        c.dispute = Some(d);
        self.calls.insert(call_id.clone(), c);
        events::emit(
            "dispute_opened",
            json!({
                "call_id": call_id, "kind": kind, "stake": U128(amount),
                "answer_by_ms": now + self.cfg.answer_ms, "response_hash": response_hash,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(req: &[&str], as_of: Option<&str>, max_age: Option<u32>) -> Terms {
        Terms {
            text: "t".into(),
            required_fields: req.iter().map(|s| s.to_string()).collect(),
            as_of_field: as_of.map(Into::into),
            max_age_s: max_age,
            panel: true,
        }
    }

    #[test]
    fn rules() {
        let t = terms(&["token", "holders"], Some("as_of"), Some(3600));
        let now_ms = 1_800_000_000_000;
        let fresh = format!(r#"{{"token":"NEAR","holders":[],"as_of":{}}}"#, 1_800_000_000 - 60);
        assert_eq!(broken_rule(&t, &fresh, now_ms), None);
        assert_eq!(broken_rule(&t, "<html>", now_ms), Some("not_json".into()));
        assert_eq!(broken_rule(&t, r#"{"token":"NEAR","as_of":1}"#, now_ms), Some("missing_field:holders".into()));
        let stale = format!(r#"{{"token":"NEAR","holders":[],"as_of":{}}}"#, 1_800_000_000 - 93_600);
        assert_eq!(broken_rule(&t, &stale, now_ms), Some("stale:93600".into()));
        assert_eq!(
            broken_rule(&t, r#"{"token":"NEAR","holders":[],"as_of":"yesterday"}"#, now_ms),
            Some("missing_field:as_of".into())
        );
        // future timestamps are not stale
        let fut = format!(r#"{{"token":"NEAR","holders":[],"as_of":{}}}"#, 1_900_000_000u64);
        assert_eq!(broken_rule(&t, &fut, now_ms), None);
        // no rules configured: any JSON passes, non-JSON fails
        let none = terms(&[], None, None);
        assert_eq!(broken_rule(&none, "[1]", now_ms), None);
        assert_eq!(broken_rule(&none, "", now_ms), Some("not_json".into()));
        // a non-object top level misses every required field
        assert_eq!(broken_rule(&t, "[1]", now_ms), Some("missing_field:token".into()));
    }
}
