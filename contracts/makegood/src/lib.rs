//! Bonded chargebacks for paid API calls (docs/DESIGN.md 4.2). Sellers post a
//! bond; buyers pay through `ft_transfer_call`; refunds come out of the bond by
//! rule, by default, or by a three-juror panel whose ed25519 signatures the
//! contract checks itself (verification level L3).
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};
use serde_json::json;

pub mod consts;
pub mod dispute;
pub mod encode;
pub mod events;
pub mod fees;
pub mod panel;
pub mod pay;
pub mod queue;

use encode::{from_hex, to_hex};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(5);

/// Panic with a stable error string (DESIGN 4.2 "Errors").
pub(crate) fn fail(code: &str) -> ! {
    env::panic_str(code)
}

pub(crate) fn hex32(s: &str) -> [u8; 32] {
    from_hex::<32>(s).unwrap_or_else(|| fail("E_BAD_ARGS"))
}

pub(crate) fn sig64(b: &Base64VecU8) -> [u8; 64] {
    b.0.as_slice().try_into().unwrap_or_else(|_| fail("E_BAD_ARGS"))
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub min_bond: U128,
    pub min_price: U128,
    pub window_min_ms: u64,
    pub window_max_ms: u64,
    pub answer_ms: u64,
    pub resolver_exclusive_ms: u64,
    pub panel_deadline_ms: u64,
    pub stake_min: U128,
    pub stake_bps: u16,
    pub max_terms: u32,
    pub max_request: u32,
    pub max_response: u32,
    /// Accept ballots of kind `gateway` (L3-gateway: `<req>:<resp>` signed by `gateway_key`).
    pub accept_gateway: bool,
}

/// Juror as passed in and returned by views: keys and hashes in lower-case hex.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JurorArg {
    pub model_id: String,
    pub pubkey: String,
    pub attestation_sha256: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Juror {
    pub model_id: String,
    pub pubkey: [u8; 32],
    pub attestation_sha256: [u8; 32],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Seller {
    pub receipt_pubkey: [u8; 32],
    pub window_ms: u64,
    pub bond: u128,
    pub reserved: u128,
    pub disputed_reserved: u128,
    pub fee_idx: u8,
    pub clean_calls_since_step: u32,
    pub clean_volume_since_step: u128,
    pub recovery_volume: u128,
    pub lifetime_calls: u64,
    pub lifetime_losses: u32,
    pub lifetime_volume: u128,
    pub q_head: u64,
    pub q_tail: u64,
}

impl Seller {
    pub fn new(receipt_pubkey: [u8; 32], window_ms: u64) -> Self {
        Self {
            receipt_pubkey,
            window_ms,
            bond: 0,
            reserved: 0,
            disputed_reserved: 0,
            fee_idx: 1,
            clean_calls_since_step: 0,
            clean_volume_since_step: 0,
            recovery_volume: 0,
            lifetime_calls: 0,
            lifetime_losses: 0,
            lifetime_volume: 0,
            q_head: 0,
            q_tail: 0,
        }
    }
    /// `bond − reserved − disputed_reserved` (saturating so weakened guard builds stay viewable).
    pub fn free(&self) -> u128 {
        self.bond.saturating_sub(self.reserved).saturating_sub(self.disputed_reserved)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Terms {
    pub text: String,
    pub required_fields: Vec<String>,
    pub as_of_field: Option<String>,
    pub max_age_s: Option<u32>,
    pub panel: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallStatus {
    Open,
    NonDeliveryClaimed,
    Disputed,
    Answered,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Dispute {
    pub opened_at_ms: u64,
    pub stake: u128,
    pub buyer_commit: [u8; 32],
    pub response_hash: [u8; 32],
    pub status_code: u16,
    pub served_at_ms: u64,
    pub seller_offer_bps: Option<u16>,
    pub answered_at_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Call {
    pub buyer: AccountId,
    pub seller: AccountId,
    pub terms_id: String,
    pub price: u128,
    pub fee: u128,
    pub reserve: u128,
    pub request_hash: [u8; 32],
    pub paid_at_ms: u64,
    pub expires_at_ms: u64,
    pub status: CallStatus,
    pub dispute: Option<Dispute>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct QueueItem {
    pub expires_at_ms: u64,
    pub call_id: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct BuyerRec {
    pub disputes_won: u32,
    pub disputes_lost: u32,
    pub stake_mult_log2: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner: AccountId,
    pub(crate) token: AccountId,
    pub(crate) resolver: AccountId,
    pub(crate) cfg: Config,
    pub(crate) jurors: Vec<Juror>,
    pub(crate) gateway_key: Option<[u8; 32]>,
    pub(crate) juror_epoch: u32,
    pub(crate) sellers: LookupMap<AccountId, Seller>,
    pub(crate) terms: LookupMap<(AccountId, String), Terms>,
    pub(crate) calls: LookupMap<String, Call>,
    pub(crate) queue: LookupMap<(AccountId, u64), QueueItem>,
    pub(crate) buyers: LookupMap<AccountId, BuyerRec>,
    pub(crate) claimable: LookupMap<AccountId, u128>,
    pub(crate) treasury: u128,
}

fn parse_jurors(jurors: Vec<JurorArg>) -> Vec<Juror> {
    require!(jurors.len() == 3, "E_BAD_ARGS");
    jurors
        .into_iter()
        .map(|j| Juror { model_id: j.model_id, pubkey: hex32(&j.pubkey), attestation_sha256: hex32(&j.attestation_sha256) })
        .collect()
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        resolver: AccountId,
        cfg: Config,
        jurors: Vec<JurorArg>,
        gateway_key: Option<String>,
    ) -> Self {
        require!(cfg.window_min_ms <= cfg.window_max_ms && cfg.stake_bps <= 10_000, "E_BAD_ARGS");
        let mut c = Self {
            owner,
            token,
            resolver,
            cfg,
            jurors: vec![],
            gateway_key: None,
            juror_epoch: 0,
            sellers: LookupMap::new(b"s"),
            terms: LookupMap::new(b"t"),
            calls: LookupMap::new(b"c"),
            queue: LookupMap::new(b"q"),
            buyers: LookupMap::new(b"b"),
            claimable: LookupMap::new(b"x"),
            treasury: 0,
        };
        c.install_jurors(jurors, gateway_key);
        c
    }

    // ---------------------------------------------------------------- owner

    pub fn set_jurors(&mut self, jurors: Vec<JurorArg>, gateway_key: Option<String>) {
        self.assert_owner();
        self.install_jurors(jurors, gateway_key);
    }

    pub fn set_resolver(&mut self, account: AccountId) {
        self.assert_owner();
        self.resolver = account.clone();
        events::emit("resolver_set", json!({ "resolver": account }));
    }

    pub fn withdraw_treasury(&mut self, amount: U128, to: AccountId) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0 && amount.0 <= self.treasury, "E_TREASURY_LOW");
        self.treasury -= amount.0;
        events::emit("treasury_withdrawn", json!({ "amount": amount, "to": to }));
        self.transfer(&to, amount.0)
    }

    // ---------------------------------------------------------------- anyone

    pub fn withdraw_claimable(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amt = self.claimable.remove(&who).unwrap_or(0);
        require!(amt > 0, "E_NOTHING_CLAIMABLE");
        self.transfer(&who, amt)
    }

    /// Callback of every outgoing `ft_transfer`: a failed transfer is credited to `claimable`.
    #[private]
    pub fn on_transfer_done(&mut self, account: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            let cur = self.claimable.get(&account).copied().unwrap_or(0);
            self.claimable.insert(account.clone(), cur + amount.0);
            events::emit("transfer_failed", json!({ "account": account, "amount": amount }));
        }
        ok
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> serde_json::Value {
        json!({
            "owner": self.owner, "token": self.token, "resolver": self.resolver,
            "cfg": self.cfg, "treasury": U128(self.treasury),
            "fee_bps": consts::FEE_BPS, "sweep_max": consts::SWEEP_MAX,
            "receipt_prefix": consts::RECEIPT_PREFIX,
        })
    }

    pub fn get_jurors(&self) -> serde_json::Value {
        json!({
            "epoch": self.juror_epoch,
            "jurors": self.jurors.iter().map(juror_json).collect::<Vec<_>>(),
            "gateway_key": self.gateway_key.map(|k| to_hex(&k)),
            "accept_gateway": self.cfg.accept_gateway,
        })
    }

    pub fn get_buyer(&self, id: AccountId) -> serde_json::Value {
        let b = self.buyers.get(&id).cloned().unwrap_or_default();
        json!({
            "disputes_won": b.disputes_won, "disputes_lost": b.disputes_lost,
            "stake_mult_log2": b.stake_mult_log2, "stake_multiplier": 1u32 << b.stake_mult_log2,
        })
    }

    pub fn claimable_of(&self, id: AccountId) -> U128 {
        U128(self.claimable.get(&id).copied().unwrap_or(0))
    }
}

pub(crate) fn juror_json(j: &Juror) -> serde_json::Value {
    json!({ "model_id": j.model_id, "pubkey": to_hex(&j.pubkey), "attestation_sha256": to_hex(&j.attestation_sha256) })
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "E_OWNER_ONLY");
    }

    fn install_jurors(&mut self, jurors: Vec<JurorArg>, gateway_key: Option<String>) {
        self.jurors = parse_jurors(jurors);
        self.gateway_key = gateway_key.as_deref().map(hex32);
        self.juror_epoch += 1;
        events::emit(
            "jurors_set",
            json!({
                "epoch": self.juror_epoch,
                "model_ids": self.jurors.iter().map(|j| j.model_id.clone()).collect::<Vec<_>>(),
                "pubkeys": self.jurors.iter().map(|j| to_hex(&j.pubkey)).collect::<Vec<_>>(),
                "attestation_sha256s": self.jurors.iter().map(|j| to_hex(&j.attestation_sha256)).collect::<Vec<_>>(),
                "gateway_key": self.gateway_key.map(|k| to_hex(&k)),
            }),
        );
    }

    /// `ft_transfer(to, amount)` with a callback that credits `claimable` on failure.
    pub(crate) fn transfer(&self, to: &AccountId, amount: u128) -> Promise {
        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_transfer_done(to.clone(), U128(amount)),
            )
    }

    /// Transfer only if positive (NEP-141 rejects zero transfers). The promise is detached.
    pub(crate) fn pay_out(&self, to: &AccountId, amount: u128) {
        if amount > 0 {
            self.transfer(to, amount).detach();
        }
    }

    pub(crate) fn seller(&self, id: &AccountId) -> Seller {
        self.sellers.get(id).cloned().unwrap_or_else(|| fail("E_NOT_REGISTERED"))
    }

    pub(crate) fn call(&self, call_id: &str) -> Call {
        self.calls.get(call_id).cloned().unwrap_or_else(|| fail("E_NO_CALL"))
    }

    pub(crate) fn base_stake(&self, price: u128) -> u128 {
        fees::stake_for(price, self.cfg.stake_min.0, self.cfg.stake_bps)
    }

    pub(crate) fn buyer_rec(&self, id: &AccountId) -> BuyerRec {
        self.buyers.get(id).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests;
