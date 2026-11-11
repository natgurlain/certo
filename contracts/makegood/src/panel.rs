//! Panel tier at verification level L3 (DESIGN 2.1, 4.2 `resolve`, 4.4): the
//! contract rebuilds each juror's request body, hashes it and the juror's raw
//! response, and checks the juror's ed25519 signature over
//! `<model_id>:<req_sha256>:<resp_sha256>` (`provider_tee`), or over
//! `<req_sha256>:<resp_sha256>` with the gateway key (`gateway`, only when
//! `cfg.accept_gateway`).
use crate::encode::{ballot_text, buyer_is_x, panel_request_body, parse_vote, to_hex};
use crate::{events, fail, fees, sig64, CallStatus, Contract, ContractExt};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{env, near, require};
use serde_json::json;

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Ballot {
    /// Raw juror response body, exactly as received (the bytes NEAR AI hashed).
    pub response_body: String,
    /// 64-byte ed25519 signature, base64.
    pub signature: Base64VecU8,
    /// `"provider_tee"` or `"gateway"`.
    pub kind: String,
    /// Ignored by the real contract (it rebuilds the request). Only the `no_g8`
    /// weakened build trusts it, to demonstrate guard G8.
    #[serde(default)]
    pub request_hash: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Vote {
    Buyer,
    Seller,
    Abstain,
}

impl Vote {
    fn as_str(self) -> &'static str {
        match self {
            Vote::Buyer => "buyer",
            Vote::Seller => "seller",
            Vote::Abstain => "abstain",
        }
    }
}

/// Map a juror's X/Y answer to a side (juror 1 sees the buyer's offer as Y).
pub fn vote_of(juror_idx: usize, response_body: &str) -> Vote {
    match parse_vote(response_body) {
        Some(x) if x == buyer_is_x(juror_idx) => Vote::Buyer,
        Some(_) => Vote::Seller,
        None => Vote::Abstain,
    }
}

/// `Some(true)` buyer wins, `Some(false)` seller wins, `None` no majority (need ≥ 2 equal votes).
pub fn majority(votes: &[Vote]) -> Option<bool> {
    let b = votes.iter().filter(|v| **v == Vote::Buyer).count();
    let s = votes.iter().filter(|v| **v == Vote::Seller).count();
    if b >= 2 {
        Some(true)
    } else if s >= 2 {
        Some(false)
    } else {
        None
    }
}

#[near]
impl Contract {
    /// Resolve an answered content dispute (see DESIGN 4.2 for preconditions).
    pub fn resolve(
        &mut self,
        call_id: String,
        buyer_offer_bps: u16,
        salt: String,
        request_canon: String,
        response_body: String,
        ballots: Vec<Ballot>,
    ) {
        let c = self.call(&call_id);
        require!(c.status == CallStatus::Answered, "E_STATUS");
        let d = c.dispute.clone().expect("answered");
        let now = env::block_timestamp_ms();
        require!(
            env::predecessor_account_id() == self.resolver || now > d.answered_at_ms + self.cfg.resolver_exclusive_ms,
            "E_RESOLVER_ONLY"
        );
        self.check_reveal(&d, buyer_offer_bps, &salt);
        require!(
            request_canon.len() <= self.cfg.max_request as usize && response_body.len() <= self.cfg.max_response as usize,
            "E_EVIDENCE_SIZE"
        );
        #[cfg(not(feature = "no_g7"))]
        require!(
            env::sha256_array(request_canon.as_bytes()) == c.request_hash
                && env::sha256_array(response_body.as_bytes()) == d.response_hash,
            "E_EVIDENCE_HASH"
        );
        let seller_bps = d.seller_offer_bps.expect("answered");
        let mut s = self.seller(&c.seller);

        if seller_bps >= buyer_offer_bps {
            // Settlement shortcut: no panel, no loss on either side.
            let refund = c.price * buyer_offer_bps as u128 / 10_000;
            s.bond -= refund;
            s.disputed_reserved -= c.reserve;
            self.sellers.insert(c.seller.clone(), s);
            self.calls.remove(&call_id);
            self.pay_out(&c.buyer, refund + d.stake);
            events::emit(
                "dispute_resolved",
                json!({
                    "call_id": call_id, "tier": "settled", "refund": U128(refund), "refund_bps": buyer_offer_bps,
                    "stake_returned": U128(d.stake), "ruling_fee": U128(0),
                }),
            );
            return;
        }

        require!(ballots.len() == 3, "E_BAD_ARGS");
        let terms = self.terms.get(&(c.seller.clone(), c.terms_id.clone())).cloned().unwrap_or_else(|| fail("E_TERMS"));
        let mut votes = [Vote::Abstain; 3];
        let mut req_shas = Vec::with_capacity(3);
        let mut resp_shas = Vec::with_capacity(3);
        for (i, b) in ballots.iter().enumerate() {
            let body = panel_request_body(
                i,
                &self.jurors[i].model_id,
                &terms.text,
                &request_canon,
                &response_body,
                buyer_offer_bps,
                seller_bps,
            );
            #[allow(unused_mut)]
            let mut req_sha = env::sha256_array(body.as_bytes());
            #[cfg(feature = "no_g8")]
            if let Some(h) = &b.request_hash {
                req_sha = crate::hex32(h);
            }
            let resp_sha = env::sha256_array(b.response_body.as_bytes());
            require!(self.ballot_sig_ok(i, &b.kind, &req_sha, &resp_sha, &sig64(&b.signature)), "E_BALLOT_SIG");
            votes[i] = vote_of(i, &b.response_body);
            req_shas.push(to_hex(&req_sha));
            resp_shas.push(to_hex(&resp_sha));
        }
        let buyer_wins = majority(&votes).unwrap_or_else(|| fail("E_NO_MAJORITY"));

        let base = self.base_stake(c.price);
        let offer = if buyer_wins { buyer_offer_bps } else { seller_bps };
        let st = fees::settle_panel(c.price, d.stake, base, offer, buyer_wins);
        s.bond -= st.bond_debit;
        s.disputed_reserved -= c.reserve;
        self.treasury += st.treasury_credit;
        let mut br = self.buyer_rec(&c.buyer);
        if buyer_wins {
            self.record_seller_loss(&c.seller, &mut s, st.refund);
            fees::buyer_won(&mut br);
        } else {
            fees::buyer_lost(&mut br);
        }
        self.buyers.insert(c.buyer.clone(), br);
        self.sellers.insert(c.seller.clone(), s);
        self.calls.remove(&call_id);
        self.pay_out(&c.buyer, st.to_buyer);

        let vote_strs: Vec<&str> = votes.iter().map(|v| v.as_str()).collect();
        events::emit(
            "ballots_verified",
            json!({
                "call_id": call_id, "epoch": self.juror_epoch,
                "kinds": ballots.iter().map(|b| b.kind.clone()).collect::<Vec<_>>(),
                "request_sha256s": req_shas, "response_sha256s": resp_shas, "votes": vote_strs,
            }),
        );
        events::emit(
            "dispute_resolved",
            json!({
                "call_id": call_id, "tier": "panel", "winner": if buyer_wins { "buyer" } else { "seller" },
                "votes": vote_strs, "refund": U128(st.refund), "refund_bps": offer,
                "to_buyer": U128(st.to_buyer), "ruling_fee": U128(st.treasury_credit),
            }),
        );
    }

    // ---------------------------------------------------------------- views

    /// The exact request body juror `juror_idx` must be sent (what `resolve` hashes).
    pub fn build_panel_request(
        &self,
        juror_idx: u8,
        terms_text: String,
        request_canon: String,
        response_body: String,
        buyer_bps: u16,
        seller_bps: u16,
    ) -> String {
        let j = self.jurors.get(juror_idx as usize).unwrap_or_else(|| fail("E_BAD_ARGS"));
        panel_request_body(juror_idx as usize, &j.model_id, &terms_text, &request_canon, &response_body, buyer_bps, seller_bps)
    }

    /// Check one recorded juror signature over given raw request and response bodies.
    pub fn verify_ballot(
        &self,
        juror_idx: u8,
        kind: String,
        request_body: String,
        response_body: String,
        signature: Base64VecU8,
    ) -> bool {
        let Ok(sig) = <[u8; 64]>::try_from(signature.0.as_slice()) else { return false };
        if juror_idx > 2 {
            return false;
        }
        let req = env::sha256_array(request_body.as_bytes());
        let resp = env::sha256_array(response_body.as_bytes());
        self.ballot_sig_ok_raw(juror_idx as usize, &kind, &req, &resp, &sig)
    }
}

impl Contract {
    fn ballot_sig_ok_raw(&self, i: usize, kind: &str, req: &[u8; 32], resp: &[u8; 32], sig: &[u8; 64]) -> bool {
        let (text, key) = match kind {
            "provider_tee" => (ballot_text(Some(&self.jurors[i].model_id), req, resp), self.jurors[i].pubkey),
            "gateway" => match self.gateway_key {
                Some(k) => (ballot_text(None, req, resp), k),
                None => return false,
            },
            _ => return false,
        };
        env::ed25519_verify(sig, text.as_bytes(), &key)
    }

    /// G1: signature check of ballot `i`; `gateway` ballots need `cfg.accept_gateway`.
    fn ballot_sig_ok(&self, i: usize, kind: &str, req: &[u8; 32], resp: &[u8; 32], sig: &[u8; 64]) -> bool {
        if kind == "gateway" && !self.cfg.accept_gateway {
            return false;
        }
        if cfg!(feature = "no_g1") {
            return matches!(kind, "provider_tee" | "gateway");
        }
        self.ballot_sig_ok_raw(i, kind, req, resp, sig)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(c: &str) -> String {
        json!({"choices":[{"message":{"content":c}}]}).to_string()
    }

    #[test]
    fn label_mapping() {
        assert_eq!(vote_of(0, &body("X")), Vote::Buyer);
        assert_eq!(vote_of(1, &body("X")), Vote::Seller);
        assert_eq!(vote_of(1, &body("Y")), Vote::Buyer);
        assert_eq!(vote_of(2, &body("Y")), Vote::Seller);
        assert_eq!(vote_of(2, "garbage"), Vote::Abstain);
    }

    #[test]
    fn majority_rules() {
        use Vote::*;
        assert_eq!(majority(&[Buyer, Buyer, Seller]), Some(true));
        assert_eq!(majority(&[Seller, Abstain, Seller]), Some(false));
        assert_eq!(majority(&[Buyer, Seller, Abstain]), None);
        assert_eq!(majority(&[Abstain, Abstain, Buyer]), None);
        assert_eq!(majority(&[Abstain, Abstain, Abstain]), None);
    }
}
