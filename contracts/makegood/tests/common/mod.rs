//! Sandbox harness shared by the integration tests. Deploys `res/mock_usdc.wasm`
//! and a contract wasm from `res/` (run `./scripts/build-contracts.sh` first).
#![allow(dead_code)]
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MODELS: [&str; 3] = ["Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017"];
pub const USDC: u128 = 1_000_000;
/// Per-transaction prepaid gas limit of nearcore 2.10.0 (300 TGas; 2.14.0 allows 1 PGas, the
/// value of near-workspaces `max_gas()`), so the tests run on both sandboxes.
pub const TX_GAS: Gas = Gas::from_tgas(300);
pub const PRICE: u128 = 400_000;
pub const TERMS: &str = "Returns the top N holders of the token named in the request, as JSON with fields: token (the requested symbol), as_of (Unix seconds), total_holders (integer), holders (array of exactly N objects).";
pub const CANON: &str = "GET\n/v1/holders?token=NEAR&top=5\n";
pub const GOOD_BODY: &str = r#"{"token":"NEAR","as_of":1794300000,"total_holders":5,"holders":[]}"#;
pub const WRONG_BODY: &str = r#"{"token":"NEO","as_of":1794300000,"total_holders":5,"holders":[]}"#;

pub fn res(path: &str) -> String {
    format!("{}/../../res/{}", env!("CARGO_MANIFEST_DIR"), path)
}
pub const REAL: &str = "makegood.wasm";
pub fn guard(n: u8) -> String {
    format!("guards/makegood_no_g{n}.wasm")
}

pub fn sha(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}
pub fn hex(b: &[u8]) -> String {
    hex::encode(b)
}
pub fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
pub fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&sha(&[seed, 0x6d, 0x67]))
}

pub fn cfg() -> Value {
    json!({
        "min_bond": "1000000", "min_price": "10000",
        "window_min_ms": 60_000, "window_max_ms": 86_400_000,
        "answer_ms": 5_000, "resolver_exclusive_ms": 60_000, "panel_deadline_ms": 300_000,
        "stake_min": "20000", "stake_bps": 500,
        "max_terms": 1024, "max_request": 1024, "max_response": 6144,
        "accept_gateway": false,
    })
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub usdc: Contract,
    pub mg: Contract,
    pub owner: Account,
    pub resolver: Account,
    pub seller: Account,
    pub buyer: Account,
    pub other: Account,
    pub seller_key: SigningKey,
    pub jurors: [SigningKey; 3],
    pub gateway: SigningKey,
    pub quote_n: std::sync::atomic::AtomicU64,
}

/// Fresh sandbox with the given makegood wasm; seller registered (window 120 s) with
/// terms `holders-v1` (panel) and `rules-v1` (rule checks), bonded 50.00; buyer holds 100.00.
pub async fn setup(wasm: &str) -> anyhow::Result<Env> {
    setup_with(wasm, cfg(), 50 * USDC).await
}

pub async fn setup_with(wasm: &str, cfg: Value, bond: u128) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mk = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .map_err(anyhow::Error::from)
        }
    };
    let usdc_acc = mk("usdc", 20).await?;
    let mg_acc = mk("mg", 50).await?;
    let owner = mk("owner", 10).await?;
    let resolver = mk("resolver", 10).await?;
    let seller = mk("seller", 10).await?;
    let buyer = mk("buyer", 10).await?;
    let other = mk("other", 10).await?;

    let usdc = usdc_acc.deploy(&std::fs::read(res("mock_usdc.wasm"))?).await?.into_result()?;
    usdc.call("new").transact().await?.into_result()?;
    let mg = mg_acc.deploy(&std::fs::read(res(wasm))?).await?.into_result()?;

    let jurors = [key(10), key(11), key(12)];
    let gateway = key(20);
    let juror_args: Vec<Value> = jurors
        .iter()
        .enumerate()
        .map(|(i, k)| json!({"model_id": MODELS[i], "pubkey": hex(k.verifying_key().as_bytes()), "attestation_sha256": hex(&sha(MODELS[i].as_bytes()))}))
        .collect();
    mg.call("new")
        .args_json(json!({
            "owner": owner.id(), "token": usdc.id(), "resolver": resolver.id(), "cfg": cfg,
            "jurors": juror_args, "gateway_key": hex(gateway.verifying_key().as_bytes()),
        }))
        .transact()
        .await?
        .into_result()?;

    let env = Env {
        worker,
        usdc,
        mg,
        owner,
        resolver,
        seller,
        buyer,
        other,
        seller_key: key(1),
        jurors,
        gateway,
        quote_n: 0.into(),
    };
    env.mint(&env.buyer, 100 * USDC).await?;
    env.mint(&env.other, 100 * USDC).await?;
    env.register(&env.seller, &env.seller_key, 120_000).await?;
    env.add_terms(&env.seller, "holders-v1", TERMS, json!([]), None, None, true).await?;
    env.add_terms(&env.seller, "rules-v1", TERMS, json!(["token", "holders"]), Some("as_of"), Some(3600), false).await?;
    if bond > 0 {
        env.mint(&env.seller, bond).await?;
        env.ftc(&env.seller, bond, json!({"action":"bond"})).await?.into_result()?;
    }
    Ok(env)
}

pub fn ok(r: &ExecutionFinalResult) {
    assert!(r.is_success() && r.receipt_failures().is_empty(), "expected success, got {:?}", r.failures());
}

/// True if any receipt of the transaction failed with `code` in its message.
pub fn failed_with(r: &ExecutionFinalResult, code: &str) -> bool {
    format!("{:?}", r.failures()).contains(code)
}

pub fn assert_err(r: &ExecutionFinalResult, code: &str) {
    assert!(failed_with(r, code), "expected {code}, got {:?}", r.failures());
}

pub fn events(r: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|e| e["event"] == name)
        .map(|e| e["data"].clone())
        .collect()
}

pub fn n(v: &Value) -> u128 {
    v.as_str().map(|s| s.parse().unwrap()).unwrap_or_else(|| v.as_u64().unwrap() as u128)
}

pub struct Receipt {
    pub response_hash: String,
    pub status_code: u16,
    pub served_at_ms: u64,
    pub sig: String,
}

pub struct Paid {
    pub call_id: String,
    pub result: ExecutionFinalResult,
}

impl Env {
    pub async fn mint(&self, who: &Account, amount: u128) -> anyhow::Result<()> {
        self.usdc
            .call("mint")
            .args_json(json!({"account_id": who.id(), "amount": amount.to_string()}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn balance(&self, who: &Account) -> anyhow::Result<u128> {
        let v: Value = self.usdc.view("ft_balance_of").args_json(json!({"account_id": who.id()})).await?.json()?;
        Ok(n(&v))
    }

    pub async fn balance_of(&self, id: &near_workspaces::AccountId) -> anyhow::Result<u128> {
        let v: Value = self.usdc.view("ft_balance_of").args_json(json!({"account_id": id})).await?.json()?;
        Ok(n(&v))
    }

    pub async fn register(&self, seller: &Account, k: &SigningKey, window_ms: u64) -> anyhow::Result<()> {
        seller
            .call(self.mg.id(), "register_seller")
            .args_json(json!({"receipt_pubkey": hex(k.verifying_key().as_bytes()), "window_ms": window_ms}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn add_terms(
        &self,
        seller: &Account,
        id: &str,
        text: &str,
        required: Value,
        as_of: Option<&str>,
        max_age: Option<u32>,
        panel: bool,
    ) -> anyhow::Result<()> {
        seller
            .call(self.mg.id(), "add_terms")
            .args_json(json!({"terms_id": id, "text": text, "required_fields": required, "as_of_field": as_of, "max_age_s": max_age, "panel": panel}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// `ft_transfer_call` into the contract.
    pub async fn ftc(&self, from: &Account, amount: u128, msg: Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": self.mg.id(), "amount": amount.to_string(), "msg": msg.to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    pub fn next_quote(&self) -> String {
        let q = self.quote_n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        format!("{:032x}", q)
    }

    pub async fn pay_as(&self, buyer: &Account, seller: &Account, terms: &str, price: u128) -> anyhow::Result<Paid> {
        let quote = self.next_quote();
        let result = self
            .ftc(
                buyer,
                price,
                json!({"action":"pay","seller":seller.id(),"quote_id":quote,"terms_id":terms,"request_hash":hex(&sha(CANON.as_bytes()))}),
            )
            .await?;
        Ok(Paid { call_id: format!("{}/{}", seller.id(), quote), result })
    }

    pub async fn pay(&self, price: u128) -> anyhow::Result<Paid> {
        let p = self.pay_as(&self.buyer, &self.seller, "holders-v1", price).await?;
        ok(&p.result);
        Ok(p)
    }

    pub async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.mg.view(method).args_json(args).await?.json()?)
    }

    pub async fn seller_view(&self) -> anyhow::Result<Value> {
        self.view("get_seller", json!({"id": self.seller.id()})).await
    }

    pub async fn call_view(&self, call_id: &str) -> anyhow::Result<Value> {
        self.view("get_call", json!({"call_id": call_id})).await
    }

    /// Seller-signed receipt; the text comes from the contract's `receipt_text` view.
    pub async fn receipt(&self, call_id: &str, body: &str, status: u16) -> anyhow::Result<Receipt> {
        self.receipt_signed_by(call_id, body, status, &self.seller_key).await
    }

    pub async fn receipt_signed_by(&self, call_id: &str, body: &str, status: u16, k: &SigningKey) -> anyhow::Result<Receipt> {
        let rh = hex(&sha(body.as_bytes()));
        let served = 1_794_300_001_234u64;
        let text: String = self
            .view("receipt_text", json!({"call_id": call_id, "response_hash": rh, "status_code": status, "served_at_ms": served}))
            .await?
            .as_str()
            .unwrap()
            .to_string();
        Ok(Receipt { response_hash: rh, status_code: status, served_at_ms: served, sig: b64(&k.sign(text.as_bytes()).to_bytes()) })
    }

    pub async fn dispute_non_delivery(&self, from: &Account, call_id: &str, stake: u128) -> anyhow::Result<ExecutionFinalResult> {
        self.ftc(from, stake, json!({"action":"dispute","kind":"non_delivery","call_id":call_id})).await
    }

    pub async fn dispute_content(
        &self,
        from: &Account,
        call_id: &str,
        r: &Receipt,
        offer_bps: u16,
        salt: [u8; 32],
        stake: u128,
    ) -> anyhow::Result<ExecutionFinalResult> {
        let mut pre = offer_bps.to_le_bytes().to_vec();
        pre.extend_from_slice(&salt);
        self.ftc(
            from,
            stake,
            json!({"action":"dispute","kind":"content","call_id":call_id,"response_hash":r.response_hash,
                   "status_code":r.status_code,"served_at_ms":r.served_at_ms,"sig":r.sig,"offer_commit":hex(&sha(&pre))}),
        )
        .await
    }

    pub async fn answer(&self, from: &Account, call_id: &str, offer_bps: u16) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from.call(self.mg.id(), "answer").args_json(json!({"call_id": call_id, "offer_bps": offer_bps})).transact().await?)
    }

    /// Juror `i`'s request body, built by the contract view.
    pub async fn panel_body(&self, i: u8, request: &str, response: &str, buyer_bps: u16, seller_bps: u16) -> anyhow::Result<String> {
        Ok(self
            .view(
                "build_panel_request",
                json!({"juror_idx": i, "terms_text": TERMS, "request_canon": request, "response_body": response,
                       "buyer_bps": buyer_bps, "seller_bps": seller_bps}),
            )
            .await?
            .as_str()
            .unwrap()
            .to_string())
    }

    /// A chat-completion response body as NEAR AI returns it, with `content`.
    pub fn chat(content: &str) -> String {
        json!({"id":"chatcmpl-test","object":"chat.completion","model":"m",
               "choices":[{"index":0,"message":{"role":"assistant","content":content},"finish_reason":"stop"}]})
        .to_string()
    }

    /// Ballot signed like NEAR AI `provider_tee`: `<model>:<sha(req)>:<sha(resp)>` with juror `i`'s key.
    pub fn ballot(&self, i: usize, request_body: &str, content: &str) -> Value {
        let resp = Self::chat(content);
        let text = format!("{}:{}:{}", MODELS[i], hex(&sha(request_body.as_bytes())), hex(&sha(resp.as_bytes())));
        json!({"response_body": resp, "signature": b64(&self.jurors[i].sign(text.as_bytes()).to_bytes()), "kind": "provider_tee"})
    }

    /// Ballot signed like NEAR AI `gateway`: `<sha(req)>:<sha(resp)>` with the gateway key.
    pub fn gateway_ballot(&self, request_body: &str, content: &str) -> Value {
        let resp = Self::chat(content);
        let text = format!("{}:{}", hex(&sha(request_body.as_bytes())), hex(&sha(resp.as_bytes())));
        json!({"response_body": resp, "signature": b64(&self.gateway.sign(text.as_bytes()).to_bytes()), "kind": "gateway"})
    }

    /// Letter juror `i` writes to vote for the buyer (`true`) or the seller.
    pub fn letter(i: usize, buyer: bool) -> &'static str {
        if (i != 1) == buyer {
            "X"
        } else {
            "Y"
        }
    }

    /// Three honest ballots for the given sides (`None` = abstain).
    pub async fn ballots(&self, response: &str, buyer_bps: u16, seller_bps: u16, sides: [Option<bool>; 3]) -> anyhow::Result<Vec<Value>> {
        let mut out = vec![];
        for (i, side) in sides.iter().enumerate() {
            let body = self.panel_body(i as u8, CANON, response, buyer_bps, seller_bps).await?;
            out.push(self.ballot(i, &body, side.map(|b| Self::letter(i, b)).unwrap_or("I cannot decide")));
        }
        Ok(out)
    }

    pub async fn resolve(
        &self,
        from: &Account,
        call_id: &str,
        buyer_bps: u16,
        salt: [u8; 32],
        response: &str,
        ballots: Vec<Value>,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from
            .call(self.mg.id(), "resolve")
            .args_json(json!({"call_id": call_id, "buyer_offer_bps": buyer_bps, "salt": hex(&salt),
                              "request_canon": CANON, "response_body": response, "ballots": ballots}))
            .gas(Gas::from_tgas(200))
            .transact()
            .await?)
    }

    pub async fn now_ms(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    /// Fast-forward until the latest block timestamp is strictly after `ts_ms`
    /// (blocks advance ~300 ms each in the sandbox).
    pub async fn advance_past(&self, ts_ms: u64) -> anyhow::Result<()> {
        loop {
            let now = self.now_ms().await?;
            if now > ts_ms {
                return Ok(());
            }
            let blocks = ((ts_ms - now) / 300).max(1);
            self.worker.fast_forward(blocks).await?;
        }
    }

    /// A full content dispute up to the seller's answer. Returns (call_id, salt).
    pub async fn answered_dispute(&self, response: &str, buyer_bps: u16, seller_bps: u16) -> anyhow::Result<(String, [u8; 32])> {
        let p = self.pay(PRICE).await?;
        let r = self.receipt(&p.call_id, response, 200).await?;
        let salt = sha(p.call_id.as_bytes());
        ok(&self.dispute_content(&self.buyer, &p.call_id, &r, buyer_bps, salt, 20_000).await?);
        ok(&self.answer(&self.seller, &p.call_id, seller_bps).await?);
        Ok((p.call_id, salt))
    }
}
