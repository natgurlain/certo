//! Seller registration, bonds, terms, payment with instant payout, and the
//! seller/call views (DESIGN 4.2).
use crate::consts::{REGISTER_DEPOSIT_YOCTO, SWEEP_MAX};
use crate::encode::{self, from_hex, to_hex};
use crate::{events, fail, fees, hex32, Call, CallStatus, Contract, ContractExt, Seller, Terms};
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{env, near, require, AccountId, Promise, PromiseOrValue};
use serde_json::{json, Value};

/// `msg` of `ft_transfer_call` into this contract.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TransferMsg {
    Bond,
    Pay {
        seller: AccountId,
        quote_id: String,
        terms_id: String,
        request_hash: String,
    },
    Dispute {
        kind: String,
        call_id: String,
        response_hash: Option<String>,
        status_code: Option<u16>,
        served_at_ms: Option<u64>,
        sig: Option<Base64VecU8>,
        offer_commit: Option<String>,
    },
}

fn valid_terms_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Caller must be `token`. A panic here makes NEP-141 return the full amount to the sender.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "E_WRONG_TOKEN");
        let m: TransferMsg = serde_json::from_str(&msg).unwrap_or_else(|_| fail("E_BAD_ARGS"));
        match m {
            TransferMsg::Bond => self.on_bond(sender_id, amount.0),
            TransferMsg::Pay { seller, quote_id, terms_id, request_hash } => {
                self.on_pay(sender_id, amount.0, seller, quote_id, terms_id, request_hash)
            }
            TransferMsg::Dispute { kind, call_id, response_hash, status_code, served_at_ms, sig, offer_commit } => self
                .on_dispute(sender_id, amount.0, kind, call_id, response_hash, status_code, served_at_ms, sig, offer_commit),
        }
        PromiseOrValue::Value(U128(0))
    }
}

#[near]
impl Contract {
    /// Register the caller as a seller. `receipt_pubkey`: 32-byte ed25519 key, lower-case hex.
    #[payable]
    pub fn register_seller(&mut self, receipt_pubkey: String, window_ms: u64) {
        require!(env::attached_deposit().as_yoctonear() >= REGISTER_DEPOSIT_YOCTO, "E_DEPOSIT");
        let id = env::predecessor_account_id();
        require!(!self.sellers.contains_key(&id), "E_REGISTERED");
        require!((self.cfg.window_min_ms..=self.cfg.window_max_ms).contains(&window_ms), "E_BAD_ARGS");
        let key = hex32(&receipt_pubkey);
        self.sellers.insert(id.clone(), Seller::new(key, window_ms));
        events::emit(
            "seller_registered",
            json!({ "seller": id, "receipt_pubkey": receipt_pubkey, "window_ms": window_ms, "fee_bps": crate::consts::FEE_BPS[1] }),
        );
    }

    /// Terms are immutable; a change is a new id.
    pub fn add_terms(
        &mut self,
        terms_id: String,
        text: String,
        required_fields: Option<Vec<String>>,
        as_of_field: Option<String>,
        max_age_s: Option<u32>,
        panel: bool,
    ) {
        let id = env::predecessor_account_id();
        self.seller(&id);
        require!(valid_terms_id(&terms_id) && text.len() <= self.cfg.max_terms as usize, "E_TERMS");
        let key = (id.clone(), terms_id.clone());
        require!(!self.terms.contains_key(&key), "E_TERMS");
        let text_sha256 = to_hex(&env::sha256_array(text.as_bytes()));
        self.terms.insert(
            key,
            Terms { text, required_fields: required_fields.unwrap_or_default(), as_of_field, max_age_s, panel },
        );
        events::emit("terms_added", json!({ "seller": id, "terms_id": terms_id, "text_sha256": text_sha256 }));
    }

    /// Withdraw part of the bond; open exposure must stay covered.
    pub fn withdraw_bond(&mut self, amount: U128) -> Promise {
        let id = env::predecessor_account_id();
        let mut s = self.seller(&id);
        self.sweep(&id, &mut s, SWEEP_MAX);
        require!(amount.0 > 0 && amount.0 <= s.bond, "E_WITHDRAW_EXPOSED");
        #[cfg(not(feature = "no_g6"))]
        require!(s.bond - amount.0 >= s.reserved + s.disputed_reserved, "E_WITHDRAW_EXPOSED");
        s.bond -= amount.0;
        events::emit("bond_changed", json!({ "seller": id, "bond": U128(s.bond), "delta": format!("-{}", amount.0) }));
        self.sellers.insert(id.clone(), s);
        self.transfer(&id, amount.0)
    }

    // ---------------------------------------------------------------- views

    pub fn get_seller(&self, id: AccountId) -> Option<Value> {
        let s = self.sellers.get(&id)?;
        let freed = self.sweep_preview(&id, s);
        let free = s.free() + freed.min(s.reserved);
        Some(json!({
            "bond": U128(s.bond),
            "reserved": U128(s.reserved),
            "disputed_reserved": U128(s.disputed_reserved),
            "free_capacity": U128(free),
            "fee_idx": s.fee_idx,
            "fee_bps": crate::consts::FEE_BPS[s.fee_idx as usize],
            "window_ms": s.window_ms,
            "lifetime_calls": s.lifetime_calls,
            "lifetime_losses": s.lifetime_losses,
            "lifetime_volume": U128(s.lifetime_volume),
            "clean_calls_since_step": s.clean_calls_since_step,
            "clean_volume_since_step": U128(s.clean_volume_since_step),
            "recovery_volume": U128(s.recovery_volume),
            "receipt_pubkey": to_hex(&s.receipt_pubkey),
            "queue_len": s.q_tail - s.q_head,
        }))
    }

    pub fn get_terms(&self, seller: AccountId, terms_id: String) -> Option<Terms> {
        self.terms.get(&(seller, terms_id)).cloned()
    }

    pub fn get_call(&self, call_id: String) -> Option<Value> {
        let c = self.calls.get(&call_id)?;
        let dispute = c.dispute.as_ref().map(|d| {
            json!({
                "kind": if c.status == CallStatus::NonDeliveryClaimed { "non_delivery" } else { "content" },
                "opened_at_ms": d.opened_at_ms,
                "answer_by_ms": d.opened_at_ms + self.cfg.answer_ms,
                "stake": U128(d.stake),
                "buyer_commit": to_hex(&d.buyer_commit),
                "response_hash": to_hex(&d.response_hash),
                "status_code": d.status_code,
                "served_at_ms": d.served_at_ms,
                "seller_offer_bps": d.seller_offer_bps,
                "answered_at_ms": d.answered_at_ms,
            })
        });
        Some(json!({
            "call_id": call_id,
            "buyer": c.buyer,
            "seller": c.seller,
            "terms_id": c.terms_id,
            "price": U128(c.price),
            "fee": U128(c.fee),
            "reserve": U128(c.reserve),
            "request_hash": to_hex(&c.request_hash),
            "paid_at_ms": c.paid_at_ms,
            "expires_at_ms": c.expires_at_ms,
            "status": c.status,
            "dispute": dispute,
        }))
    }

    /// Fee, base ruling stake and whether a payment of `price` fits now.
    pub fn quote(&self, seller: AccountId, price: U128) -> Value {
        let s = self.seller(&seller);
        let stake = self.base_stake(price.0);
        let free = s.free() + self.sweep_preview(&seller, &s).min(s.reserved);
        json!({
            "fee": U128(fees::fee_for(price.0, s.fee_idx)),
            "fee_bps": crate::consts::FEE_BPS[s.fee_idx as usize],
            "stake": U128(stake),
            "reserve": U128(price.0 + stake),
            "free_capacity": U128(free),
            "would_fit": s.bond >= self.cfg.min_bond.0 && free >= price.0 + stake,
        })
    }

    /// The receipt text the seller must sign for this call (hashes in lower-case hex).
    pub fn receipt_text(&self, call_id: String, response_hash: String, status_code: u16, served_at_ms: u64) -> String {
        let c = self.call(&call_id);
        encode::receipt_text(
            env::current_account_id().as_str(),
            &call_id,
            c.buyer.as_str(),
            c.price,
            &c.terms_id,
            &c.request_hash,
            &hex32(&response_hash),
            status_code,
            served_at_ms,
        )
    }
}

impl Contract {
    fn on_bond(&mut self, sender: AccountId, amount: u128) {
        let mut s = self.seller(&sender);
        s.bond += amount;
        events::emit("bond_changed", json!({ "seller": sender, "bond": U128(s.bond), "delta": amount.to_string() }));
        self.sellers.insert(sender, s);
    }

    fn on_pay(
        &mut self,
        buyer: AccountId,
        amount: u128,
        seller_id: AccountId,
        quote_id: String,
        terms_id: String,
        request_hash: String,
    ) {
        let mut s = self.seller(&seller_id);
        require!(s.bond >= self.cfg.min_bond.0, "E_BOND_LOW");
        require!(self.terms.contains_key(&(seller_id.clone(), terms_id.clone())), "E_TERMS");
        require!(amount >= self.cfg.min_price.0, "E_PRICE_MIN");
        require!(from_hex::<16>(&quote_id).is_some(), "E_BAD_ARGS");
        let request_hash = hex32(&request_hash);
        let call_id = format!("{}/{}", seller_id, quote_id);
        require!(!self.calls.contains_key(&call_id), "E_DUP_CALL");

        self.sweep(&seller_id, &mut s, SWEEP_MAX);
        let reserve = amount + self.base_stake(amount);
        #[cfg(not(feature = "no_g2"))]
        require!(s.free() >= reserve, "E_EXPOSURE");

        let fee = fees::fee_for(amount, s.fee_idx);
        let fee_bps = crate::consts::FEE_BPS[s.fee_idx as usize];
        let now = env::block_timestamp_ms();
        let expires_at_ms = now + s.window_ms;
        self.treasury += fee;
        s.reserved += reserve;
        self.calls.insert(
            call_id.clone(),
            Call {
                buyer: buyer.clone(),
                seller: seller_id.clone(),
                terms_id,
                price: amount,
                fee,
                reserve,
                request_hash,
                paid_at_ms: now,
                expires_at_ms,
                status: CallStatus::Open,
                dispute: None,
            },
        );
        self.enqueue(&seller_id, &mut s, expires_at_ms, call_id.clone());
        self.sellers.insert(seller_id.clone(), s);
        self.pay_out(&seller_id, amount - fee);
        events::emit(
            "call_paid",
            json!({
                "call_id": call_id, "buyer": buyer, "seller": seller_id,
                "price": U128(amount), "fee": U128(fee), "fee_bps": fee_bps,
                "expires_at_ms": expires_at_ms, "request_hash": to_hex(&request_hash),
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_id_format() {
        assert!(valid_terms_id("holders-v1"));
        assert!(valid_terms_id(&"a".repeat(32)));
        assert!(!valid_terms_id(&"a".repeat(33)));
        assert!(!valid_terms_id(""));
        assert!(!valid_terms_id("Holders"));
        assert!(!valid_terms_id("a_b"));
    }

    #[test]
    fn msg_parsing() {
        let m: TransferMsg = serde_json::from_str(r#"{"action":"bond"}"#).unwrap();
        assert!(matches!(m, TransferMsg::Bond));
        let m: TransferMsg = serde_json::from_str(
            r#"{"action":"dispute","kind":"content","call_id":"s/x","response_hash":"aa","status_code":200,"served_at_ms":5,"sig":"AAAA","offer_commit":"bb"}"#,
        )
        .unwrap();
        assert!(matches!(m, TransferMsg::Dispute { status_code: Some(200), .. }));
        assert!(serde_json::from_str::<TransferMsg>(r#"{"action":"steal"}"#).is_err());
    }
}
