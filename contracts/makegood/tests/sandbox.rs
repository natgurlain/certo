//! Sandbox integration tests for the acceptance checks of T06 (core), T07 (panel
//! primitives) and T08 (disputes, settlement, fees). Guard tests are in guards.rs.
mod common;
use common::*;
use serde_json::{json, Value};

async fn treasury(e: &Env) -> anyhow::Result<u128> {
    Ok(n(&e.view("get_config", json!({})).await?["treasury"]))
}

async fn bond(e: &Env) -> anyhow::Result<u128> {
    Ok(n(&e.seller_view().await?["bond"]))
}

// ------------------------------------------------------------------ T06

#[tokio::test]
async fn t06_pay_moves_price_minus_fee_to_seller_in_same_tx() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let q: Value = e.view("quote", json!({"seller": e.seller.id(), "price": "400000"})).await?;
    assert_eq!((n(&q["fee"]), n(&q["stake"]), q["would_fit"].as_bool()), (4_000, 20_000, Some(true)));
    let (sb, bb) = (e.balance(&e.seller).await?, e.balance(&e.buyer).await?);
    let p = e.pay(PRICE).await?;
    // the payout is a receipt of the paying transaction itself
    assert_eq!(e.balance(&e.seller).await? - sb, 396_000);
    assert_eq!(bb - e.balance(&e.buyer).await?, 400_000);
    assert_eq!(treasury(&e).await?, 4_000);
    let ev = &events(&p.result, "call_paid")[0];
    assert_eq!((n(&ev["price"]), n(&ev["fee"]), ev["fee_bps"].as_u64()), (400_000, 4_000, Some(100)));
    let c = e.call_view(&p.call_id).await?;
    assert_eq!(c["status"], "Open");
    assert_eq!(c["request_hash"], hex(&sha(CANON.as_bytes())));
    let s = e.seller_view().await?;
    assert_eq!((n(&s["reserved"]), n(&s["free_capacity"])), (420_000, 50 * USDC - 420_000));
    println!("pay (ft_transfer_call) gas burnt: {:.2} TGas", p.result.total_gas_burnt.as_gas() as f64 / 1e12);
    // duplicate quote id is refused and refunded
    let dup = e
        .ftc(&e.buyer, PRICE, json!({"action":"pay","seller":e.seller.id(),"quote_id":p.call_id.split('/').nth(1).unwrap(),
                                       "terms_id":"holders-v1","request_hash":hex(&sha(CANON.as_bytes()))}))
        .await?;
    assert_err(&dup, "E_DUP_CALL");
    // unknown terms, price below minimum, unregistered seller
    let bad = e.pay_as(&e.buyer, &e.seller, "nope", PRICE).await?;
    assert_err(&bad.result, "E_TERMS");
    let low = e.pay_as(&e.buyer, &e.seller, "holders-v1", 9_999).await?;
    assert_err(&low.result, "E_PRICE_MIN");
    let unreg = e.pay_as(&e.buyer, &e.other, "holders-v1", PRICE).await?;
    assert_err(&unreg.result, "E_NOT_REGISTERED");
    Ok(())
}

#[tokio::test]
async fn t06_lazy_release_and_withdraw() -> anyhow::Result<()> {
    let e = setup_with(REAL, cfg(), USDC).await?;
    let p = e.pay(PRICE).await?;
    let exp = n(&e.call_view(&p.call_id).await?["expires_at_ms"]) as u64;
    // nobody calls release: the view already shows the capacity after a simulated sweep
    e.advance_past(exp).await?;
    let s = e.seller_view().await?;
    assert_eq!((n(&s["reserved"]), n(&s["free_capacity"])), (420_000, USDC));
    let r = e.other.call(e.mg.id(), "release").args_json(json!({"seller": e.seller.id(), "max": 5})).gas(TX_GAS).transact().await?;
    ok(&r);
    assert_eq!(events(&r, "call_released").len(), 1);
    assert!(e.call_view(&p.call_id).await?.is_null(), "a released call is deleted");
    let s = e.seller_view().await?;
    assert_eq!((n(&s["reserved"]), n(&s["lifetime_calls"]), n(&s["lifetime_volume"])), (0, 1, 400_000));
    // a dispute on a released call finds nothing
    assert_err(&e.dispute_non_delivery(&e.buyer, &p.call_id, 20_000).await?, "E_NO_CALL");
    // withdraw the whole free bond
    let before = e.balance(&e.seller).await?;
    let r = e.seller.call(e.mg.id(), "withdraw_bond").args_json(json!({"amount": USDC.to_string()})).gas(TX_GAS).transact().await?;
    ok(&r);
    assert_eq!(e.balance(&e.seller).await? - before, USDC);
    assert_eq!(bond(&e).await?, 0);
    // below min_bond no calls are accepted
    assert_err(&e.pay_as(&e.buyer, &e.seller, "holders-v1", PRICE).await?.result, "E_BOND_LOW");
    Ok(())
}

// ------------------------------------------------------------------ T07

#[tokio::test]
async fn t07_build_panel_request_matches_golden_vectors() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let raw = std::fs::read_to_string(format!("{}/../../fixtures/vectors.json", env!("CARGO_MANIFEST_DIR")))?;
    let v: Value = serde_json::from_str(&raw)?;
    let mut n_ok = 0;
    for p in v["panel_requests"].as_array().unwrap() {
        let body: String = e
            .view(
                "build_panel_request",
                json!({"juror_idx": p["juror_idx"], "terms_text": p["terms_text"], "request_canon": p["request_canon"],
                       "response_body": p["response_body"], "buyer_bps": p["buyer_bps"], "seller_bps": p["seller_bps"]}),
            )
            .await?
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(body, p["body"].as_str().unwrap(), "{}", p["name"]);
        assert_eq!(hex(&sha(body.as_bytes())), p["body_sha256"].as_str().unwrap());
        n_ok += 1;
    }
    println!("build_panel_request: {n_ok} golden bodies byte-identical on chain");
    assert_eq!(n_ok, v["panel_requests"].as_array().unwrap().len());
    Ok(())
}

#[tokio::test]
async fn t07_verify_ballot_view_checks_juror_signature() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let req = e.panel_body(0, CANON, WRONG_BODY, 10_000, 0).await?;
    let b = e.ballot(0, &req, "X");
    let args = |kind: &str, body: &Value, sig: &Value, idx: u8| {
        json!({"juror_idx": idx, "kind": kind, "request_body": req, "response_body": body, "signature": sig})
    };
    assert_eq!(e.view("verify_ballot", args("provider_tee", &b["response_body"], &b["signature"], 0)).await?, true);
    // wrong juror key, altered body
    assert_eq!(e.view("verify_ballot", args("provider_tee", &b["response_body"], &b["signature"], 1)).await?, false);
    assert_eq!(e.view("verify_ballot", args("provider_tee", &json!(Env::chat("Y")), &b["signature"], 0)).await?, false);
    let g = e.gateway_ballot(&req, "X");
    assert_eq!(e.view("verify_ballot", args("gateway", &g["response_body"], &g["signature"], 2)).await?, true);
    let jur = e.view("get_jurors", json!({})).await?;
    assert_eq!((jur["epoch"].as_u64(), jur["jurors"][1]["model_id"].as_str()), (Some(1), Some(MODELS[1])));
    Ok(())
}

// ------------------------------------------------------------------ T08: dispute table (4.3)

#[tokio::test]
async fn t08_signed_error_refund_by_rule() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let p = e.pay(PRICE).await?;
    let claim = |r: &Receipt| {
        json!({"call_id": p.call_id, "response_hash": r.response_hash, "status_code": r.status_code,
               "served_at_ms": r.served_at_ms, "sig": r.sig})
    };
    let ok200 = e.receipt(&p.call_id, GOOD_BODY, 200).await?;
    assert_err(&e.buyer.call(e.mg.id(), "claim_error").args_json(claim(&ok200)).transact().await?, "E_HTTP_STATUS");
    let err = e.receipt(&p.call_id, "{\"error\":\"upstream down\"}", 503).await?;
    let bb = e.balance(&e.buyer).await?;
    let r = e.buyer.call(e.mg.id(), "claim_error").args_json(claim(&err)).gas(TX_GAS).transact().await?;
    ok(&r);
    let ev = &events(&r, "dispute_resolved")[0];
    assert_eq!((ev["tier"].as_str(), ev["reason"].as_str(), n(&ev["refund"])), (Some("rule"), Some("seller_error"), PRICE));
    assert_eq!(e.balance(&e.buyer).await? - bb, PRICE);
    let s = e.seller_view().await?;
    assert_eq!((n(&s["bond"]), n(&s["reserved"]), s["fee_bps"].as_u64(), n(&s["lifetime_losses"])), (49_600_000, 0, Some(150), 1));
    assert_eq!(events(&r, "fee_tier_changed")[0]["fee_bps"], 150);
    Ok(())
}

#[tokio::test]
async fn t08_non_delivery_not_cured_full_refund_and_ruling_fee() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let p = e.pay(PRICE).await?;
    assert_err(&e.dispute_non_delivery(&e.buyer, &p.call_id, 19_999).await?, "E_STAKE_LOW");
    let bb = e.balance(&e.buyer).await?;
    let r = e.dispute_non_delivery(&e.buyer, &p.call_id, 20_000).await?;
    ok(&r);
    assert_eq!(events(&r, "dispute_opened")[0]["kind"], "non_delivery");
    let s = e.seller_view().await?;
    assert_eq!((n(&s["reserved"]), n(&s["disputed_reserved"])), (0, 420_000));
    let rd = || e.other.call(e.mg.id(), "resolve_default").args_json(json!({"call_id": p.call_id})).gas(TX_GAS).transact();
    assert_err(&rd().await?, "E_TOO_EARLY");
    let opened = n(&e.call_view(&p.call_id).await?["dispute"]["opened_at_ms"]) as u64;
    e.advance_past(opened + 5_000).await?;
    let r = rd().await?;
    ok(&r);
    let ev = &events(&r, "dispute_resolved")[0];
    assert_eq!((ev["reason"].as_str(), n(&ev["refund"]), n(&ev["ruling_fee"])), (Some("seller_no_answer"), PRICE, 20_000));
    assert_eq!(e.balance(&e.buyer).await? - bb, PRICE, "full refund and stake returned");
    assert_eq!(bond(&e).await?, 50 * USDC - 420_000);
    assert_eq!(treasury(&e).await?, 4_000 + 20_000);
    let buyer: Value = e.view("get_buyer", json!({"id": e.buyer.id()})).await?;
    assert_eq!(buyer["disputes_won"], 1);
    Ok(())
}

#[tokio::test]
async fn t08_non_delivery_cured_opens_fresh_window_and_returns_stake() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let p = e.pay(PRICE).await?;
    let bb = e.balance(&e.buyer).await?;
    ok(&e.dispute_non_delivery(&e.buyer, &p.call_id, 20_000).await?);
    let rc = e.receipt(&p.call_id, GOOD_BODY, 200).await?;
    let cure = |who: &near_workspaces::Account, body: &str| {
        who.call(e.mg.id(), "cure")
            .args_json(json!({"call_id": p.call_id, "response_hash": rc.response_hash, "status_code": 200,
                              "served_at_ms": rc.served_at_ms, "sig": rc.sig, "response_body": body}))
            .gas(TX_GAS)
            .transact()
    };
    assert_err(&cure(&e.buyer, GOOD_BODY).await?, "E_NOT_SELLER");
    assert_err(&cure(&e.seller, WRONG_BODY).await?, "E_EVIDENCE_HASH");
    let r = cure(&e.seller, GOOD_BODY).await?;
    ok(&r);
    assert_eq!(events(&r, "cured").len(), 1);
    assert_eq!(e.balance(&e.buyer).await?, bb, "stake returned on cure");
    let s = e.seller_view().await?;
    assert_eq!((n(&s["reserved"]), n(&s["disputed_reserved"]), n(&s["lifetime_losses"])), (420_000, 0, 0));
    // the buyer can now dispute the (public) content in the fresh window
    ok(&e.dispute_content(&e.buyer, &p.call_id, &rc, 10_000, [3; 32], 20_000).await?);
    Ok(())
}

#[tokio::test]
async fn t08_non_delivery_cured_with_5xx_is_a_rule_refund() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let p = e.pay(PRICE).await?;
    let bb = e.balance(&e.buyer).await?;
    ok(&e.dispute_non_delivery(&e.buyer, &p.call_id, 20_000).await?);
    let body = "{\"error\":\"timeout\"}";
    let rc = e.receipt(&p.call_id, body, 504).await?;
    let r = e
        .seller
        .call(e.mg.id(), "cure")
        .args_json(json!({"call_id": p.call_id, "response_hash": rc.response_hash, "status_code": 504,
                          "served_at_ms": rc.served_at_ms, "sig": rc.sig, "response_body": body}))
        .gas(TX_GAS)
        .transact()
        .await?;
    ok(&r);
    assert_eq!(events(&r, "dispute_resolved")[0]["reason"], "seller_error");
    assert_eq!(e.balance(&e.buyer).await? - bb, PRICE);
    Ok(())
}

#[tokio::test]
async fn t08_claim_rule_stale_missing_not_json() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let served_s = 1_794_300_001u64; // receipt served_at_ms / 1000
    let cases = [
        (format!(r#"{{"token":"NEAR","holders":[],"as_of":{}}}"#, served_s - 93_600), Some("stale:93600")),
        (r#"{"token":"NEAR","as_of":1794300000}"#.to_string(), Some("missing_field:holders")),
        ("<html>502 Bad Gateway</html>".to_string(), Some("not_json")),
        (format!(r#"{{"token":"NEAR","holders":[],"as_of":{}}}"#, served_s - 60), None),
    ];
    for (body, want) in cases {
        let p = e.pay_as(&e.buyer, &e.seller, "rules-v1", PRICE).await?;
        ok(&p.result);
        let rc = e.receipt(&p.call_id, &body, 200).await?;
        let r = e
            .buyer
            .call(e.mg.id(), "claim_rule")
            .args_json(json!({"call_id": p.call_id, "response_hash": rc.response_hash, "status_code": 200,
                              "served_at_ms": rc.served_at_ms, "sig": rc.sig, "response_body": body}))
            .gas(TX_GAS)
            .transact()
            .await?;
        match want {
            Some(reason) => {
                ok(&r);
                assert_eq!(events(&r, "dispute_resolved")[0]["reason"], reason);
            }
            None => {
                assert_err(&r, "E_RULE_NOT_BROKEN");
                assert_eq!(e.call_view(&p.call_id).await?["status"], "Open", "nothing changes");
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn t08_content_dispute_seller_does_not_answer() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let p = e.pay(PRICE).await?;
    let rc = e.receipt(&p.call_id, WRONG_BODY, 200).await?;
    // a content dispute needs panel terms and a < 500 receipt
    let p2 = e.pay_as(&e.buyer, &e.seller, "rules-v1", PRICE).await?;
    let rc2 = e.receipt(&p2.call_id, WRONG_BODY, 200).await?;
    assert_err(&e.dispute_content(&e.buyer, &p2.call_id, &rc2, 10_000, [1; 32], 20_000).await?, "E_NO_PANEL_TERMS");
    let rc5 = e.receipt(&p.call_id, WRONG_BODY, 500).await?;
    assert_err(&e.dispute_content(&e.buyer, &p.call_id, &rc5, 10_000, [1; 32], 20_000).await?, "E_HTTP_STATUS");
    let bb = e.balance(&e.buyer).await?;
    ok(&e.dispute_content(&e.buyer, &p.call_id, &rc, 10_000, [1; 32], 20_000).await?);
    let opened = n(&e.call_view(&p.call_id).await?["dispute"]["opened_at_ms"]) as u64;
    e.advance_past(opened + 5_000).await?;
    assert_err(&e.answer(&e.seller, &p.call_id, 0).await?, "E_ANSWER_LATE");
    let r = e.other.call(e.mg.id(), "resolve_default").args_json(json!({"call_id": p.call_id})).gas(TX_GAS).transact().await?;
    ok(&r);
    assert_eq!(events(&r, "dispute_resolved")[0]["reason"], "seller_no_answer");
    assert_eq!(e.balance(&e.buyer).await? - bb, PRICE);
    Ok(())
}

#[tokio::test]
async fn t08_seller_offer_at_least_buyer_offer_settles_without_panel() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let p = e.pay(PRICE).await?;
    let rc = e.receipt(&p.call_id, WRONG_BODY, 200).await?;
    ok(&e.dispute_content(&e.buyer, &p.call_id, &rc, 5_000, [5; 32], 20_000).await?);
    assert_err(&e.answer(&e.seller, &p.call_id, 5_050).await?, "E_OFFER_RANGE");
    ok(&e.answer(&e.seller, &p.call_id, 6_000).await?);
    let bb = e.balance(&e.buyer).await?;
    let r = e.resolve(&e.resolver, &p.call_id, 5_000, [5; 32], WRONG_BODY, vec![]).await?;
    ok(&r);
    let ev = &events(&r, "dispute_resolved")[0];
    assert_eq!((ev["tier"].as_str(), n(&ev["refund"])), (Some("settled"), 200_000));
    assert_eq!(e.balance(&e.buyer).await? - bb, 200_000 + 20_000, "buyer's offer plus own stake");
    let s = e.seller_view().await?;
    assert_eq!((n(&s["bond"]), s["fee_bps"].as_u64(), n(&s["lifetime_losses"])), (50 * USDC - 200_000, Some(100), 0));
    Ok(())
}

// ------------------------------------------------------------------ T08: settlement table, fees, buyer record

#[tokio::test]
async fn t08_panel_buyer_wins_scene2_numbers_and_gas() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let (id, salt) = e.answered_dispute(WRONG_BODY, 10_000, 0).await?;
    let bb = e.balance(&e.buyer).await?;
    let t0 = treasury(&e).await?;
    let b = e.ballots(WRONG_BODY, 10_000, 0, [Some(true); 3]).await?;
    let r = e.resolve(&e.resolver, &id, 10_000, salt, WRONG_BODY, b).await?;
    ok(&r);
    println!(
        "GAS resolve with 3 ballots (L3, provider_tee): {:.2} TGas burnt in total ({} receipts)",
        r.total_gas_burnt.as_gas() as f64 / 1e12,
        r.receipt_outcomes().len()
    );
    let ev = &events(&r, "ballots_verified")[0];
    assert_eq!(ev["votes"], json!(["buyer", "buyer", "buyer"]));
    assert_eq!(ev["epoch"], 1);
    let ev = &events(&r, "dispute_resolved")[0];
    assert_eq!((ev["tier"].as_str(), ev["winner"].as_str(), n(&ev["refund"]), n(&ev["ruling_fee"])), (Some("panel"), Some("buyer"), PRICE, 20_000));
    assert_eq!(e.balance(&e.buyer).await? - bb, PRICE + 20_000, "refund + own stake");
    assert_eq!(bond(&e).await?, 49_580_000, "bond 50.00 -> 49.58");
    assert_eq!(treasury(&e).await? - t0, 20_000);
    let s = e.seller_view().await?;
    assert_eq!((s["fee_bps"].as_u64(), n(&s["disputed_reserved"])), (Some(150), 0));
    // the next call pays the raised fee: 0.006
    let p = e.pay(PRICE).await?;
    assert_eq!(n(&events(&p.result, "call_paid")[0]["fee"]), 6_000);
    Ok(())
}

#[tokio::test]
async fn t08_panel_seller_wins_scene3_stake_forfeited_and_buyer_record() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let (id, salt) = e.answered_dispute(GOOD_BODY, 10_000, 0).await?;
    let bb = e.balance(&e.buyer).await?;
    let t0 = treasury(&e).await?;
    let b = e.ballots(GOOD_BODY, 10_000, 0, [Some(false), Some(false), Some(true)]).await?;
    let r = e.resolve(&e.resolver, &id, 10_000, salt, GOOD_BODY, b).await?;
    ok(&r);
    let ev = &events(&r, "dispute_resolved")[0];
    assert_eq!((ev["winner"].as_str(), n(&ev["refund"]), n(&ev["ruling_fee"])), (Some("seller"), 0, 20_000));
    assert_eq!(e.balance(&e.buyer).await?, bb, "seller's 0% offer: nothing back, stake 0.02 forfeited");
    assert_eq!(treasury(&e).await? - t0, 20_000);
    assert_eq!(bond(&e).await?, 50 * USDC);
    assert_eq!(e.seller_view().await?["fee_bps"], 100, "a panel win is not a loss");
    let br: Value = e.view("get_buyer", json!({"id": e.buyer.id()})).await?;
    assert_eq!((br["disputes_lost"].as_u64(), br["stake_multiplier"].as_u64()), (Some(1), Some(2)));
    // second dispute by the same buyer needs a 0.04 stake
    let p = e.pay(PRICE).await?;
    assert_err(&e.dispute_non_delivery(&e.buyer, &p.call_id, 20_000).await?, "E_STAKE_LOW");
    ok(&e.dispute_non_delivery(&e.buyer, &p.call_id, 40_000).await?);
    Ok(())
}

#[tokio::test]
async fn t08_panel_seller_partial_offer_wins() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let (id, salt) = e.answered_dispute(WRONG_BODY, 10_000, 2_500).await?;
    let bb = e.balance(&e.buyer).await?;
    let b = e.ballots(WRONG_BODY, 10_000, 2_500, [Some(false), Some(false), Some(false)]).await?;
    let r = e.resolve(&e.resolver, &id, 10_000, salt, WRONG_BODY, b).await?;
    ok(&r);
    assert_eq!(e.balance(&e.buyer).await? - bb, 100_000, "seller's 25% offer");
    assert_eq!(bond(&e).await?, 50 * USDC - 100_000);
    Ok(())
}

#[tokio::test]
async fn t08_panel_deadline_default_midpoint_or_seller_offer() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let (a, salt_a) = e.answered_dispute(WRONG_BODY, 10_000, 2_000).await?;
    let (b, _) = e.answered_dispute(WRONG_BODY, 10_000, 2_000).await?;
    let rd = |id: &str, args: Value| {
        let mut a = json!({"call_id": id});
        a.as_object_mut().unwrap().extend(args.as_object().unwrap().clone());
        e.other.call(e.mg.id(), "resolve_default").args_json(a).gas(TX_GAS).transact()
    };
    assert_err(&rd(&a, json!({})).await?, "E_TOO_EARLY");
    let answered = n(&e.call_view(&b).await?["dispute"]["answered_at_ms"]) as u64;
    e.advance_past(answered + 300_000).await?;
    let bb = e.balance(&e.buyer).await?;
    let t0 = treasury(&e).await?;
    // valid reveal: midpoint of 100% and 20% = 60%, stake back
    assert_err(&rd(&a, json!({"buyer_offer_bps": 9_000, "salt": hex(&salt_a)})).await?, "E_COMMIT_MISMATCH");
    let r = rd(&a, json!({"buyer_offer_bps": 10_000, "salt": hex(&salt_a)})).await?;
    ok(&r);
    assert_eq!(events(&r, "dispute_resolved")[0]["reason"], "midpoint");
    assert_eq!(e.balance(&e.buyer).await? - bb, 240_000 + 20_000);
    // no reveal: seller's offer, stake to treasury
    let r = rd(&b, json!({})).await?;
    ok(&r);
    assert_eq!(events(&r, "dispute_resolved")[0]["reason"], "no_reveal");
    assert_eq!(e.balance(&e.buyer).await? - bb, 260_000 + 80_000);
    assert_eq!(treasury(&e).await? - t0, 20_000);
    Ok(())
}

#[tokio::test]
async fn t08_gateway_ballots_only_behind_config_flag() -> anyhow::Result<()> {
    // default config: gateway signatures are refused
    let e = setup(REAL).await?;
    let (id, salt) = e.answered_dispute(WRONG_BODY, 10_000, 0).await?;
    let mut ballots = vec![];
    for i in 0..3u8 {
        let body = e.panel_body(i, CANON, WRONG_BODY, 10_000, 0).await?;
        ballots.push(e.gateway_ballot(&body, Env::letter(i as usize, true)));
    }
    assert_err(&e.resolve(&e.resolver, &id, 10_000, salt, WRONG_BODY, ballots.clone()).await?, "E_BALLOT_SIG");

    // accept_gateway = true: the same kind of ballots resolve (L3-gateway)
    let mut c = cfg();
    c["accept_gateway"] = json!(true);
    let e = setup_with(REAL, c, 50 * USDC).await?;
    let (id, salt) = e.answered_dispute(WRONG_BODY, 10_000, 0).await?;
    let mut ballots = vec![];
    for i in 0..3u8 {
        let body = e.panel_body(i, CANON, WRONG_BODY, 10_000, 0).await?;
        ballots.push(if i == 1 { e.ballot(1, &body, "Y") } else { e.gateway_ballot(&body, "X") });
    }
    let r = e.resolve(&e.resolver, &id, 10_000, salt, WRONG_BODY, ballots).await?;
    ok(&r);
    assert_eq!(events(&r, "ballots_verified")[0]["kinds"], json!(["gateway", "provider_tee", "gateway"]));
    println!("GAS resolve with 3 ballots (L3-gateway mix): {:.2} TGas", r.total_gas_burnt.as_gas() as f64 / 1e12);
    Ok(())
}

#[tokio::test]
async fn t08_set_jurors_epoch_and_owner_only() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let (id, salt) = e.answered_dispute(WRONG_BODY, 10_000, 0).await?;
    let old = e.ballots(WRONG_BODY, 10_000, 0, [Some(true); 3]).await?;
    let new_keys = [key(30), key(31), key(32)];
    let jurors: Vec<Value> = new_keys
        .iter()
        .enumerate()
        .map(|(i, k)| json!({"model_id": MODELS[i], "pubkey": hex(k.verifying_key().as_bytes()), "attestation_sha256": "11".repeat(32)}))
        .collect();
    let set = |who: &near_workspaces::Account| {
        who.call(e.mg.id(), "set_jurors").args_json(json!({"jurors": jurors, "gateway_key": null})).transact()
    };
    assert_err(&set(&e.other).await?, "E_OWNER_ONLY");
    let r = set(&e.owner).await?;
    ok(&r);
    assert_eq!(events(&r, "jurors_set")[0]["epoch"], 2);
    // ballots signed with the old keys no longer verify
    assert_err(&e.resolve(&e.resolver, &id, 10_000, salt, WRONG_BODY, old).await?, "E_BALLOT_SIG");
    Ok(())
}

#[tokio::test]
async fn t08_resolve_rejects_oversized_evidence_and_wrong_status() -> anyhow::Result<()> {
    let e = setup(REAL).await?;
    let p = e.pay(PRICE).await?;
    // resolve on an open call
    assert_err(&e.resolve(&e.resolver, &p.call_id, 10_000, [0; 32], WRONG_BODY, vec![]).await?, "E_STATUS");
    let big = format!("{{\"pad\":\"{}\"}}", "a".repeat(6200));
    let (id, salt) = e.answered_dispute(&big, 10_000, 0).await?;
    let r = e.resolve(&e.resolver, &id, 10_000, salt, &big, vec![]).await?;
    assert_err(&r, "E_EVIDENCE_SIZE");
    Ok(())
}

// ------------------------------------------------------------------ T07: recorded NEAR AI ballots

fn decode64or_hex(s: &str, len: usize) -> Vec<u8> {
    use base64::Engine;
    let h = s.strip_prefix("0x").unwrap_or(s);
    if h.len() == 2 * len {
        if let Ok(b) = hex::decode(h) {
            return b;
        }
    }
    base64::engine::general_purpose::STANDARD.decode(s).expect("hex or base64")
}

/// T07 last check: every recording in `fixtures/panel/*.json` (DESIGN 4.4 replay format)
/// verifies inside the sandbox contract via `verify_ballot`, after the owner registers the
/// recorded signing key. Passes vacuously, and says so, while no recording exists.
#[tokio::test]
async fn t07_recorded_nearai_signatures_verify_on_chain() -> anyhow::Result<()> {
    let dir = std::env::var("MAKEGOOD_PANEL_DIR")
        .unwrap_or_else(|_| format!("{}/../../fixtures/panel", env!("CARGO_MANIFEST_DIR")));
    let mut files: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect(),
        Err(_) => vec![],
    };
    files.sort();
    if files.is_empty() {
        println!("t07: no recordings in fixtures/panel yet; nothing to verify");
        return Ok(());
    }
    let e = setup(REAL).await?;
    let (mut real, mut synthetic) = (0, 0);
    for f in files {
        let r: Value = serde_json::from_str(&std::fs::read_to_string(&f)?)?;
        let model = r["model"].as_str().unwrap();
        let idx = MODELS.iter().position(|m| *m == model).expect("recording for a registered juror model");
        let sig = &r["signature"];
        let kind = sig["signature_kind"].as_str().unwrap();
        let pubkey = hex(&decode64or_hex(sig["signing_address"].as_str().unwrap(), 32));
        let resp_bytes = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(r["response_body_b64"].as_str().unwrap())?
        };
        let resp = String::from_utf8(resp_bytes).expect("UTF-8 juror response");
        let req = r["request_body"].as_str().unwrap();
        // the signed text is exactly what the contract rebuilds
        let want = if kind == "provider_tee" {
            format!("{}:{}:{}", model, hex(&sha(req.as_bytes())), hex(&sha(resp.as_bytes())))
        } else {
            format!("{}:{}", hex(&sha(req.as_bytes())), hex(&sha(resp.as_bytes())))
        };
        assert_eq!(sig["text"].as_str().unwrap(), want, "{}", f.display());
        // register the recorded key for this juror (or as the gateway key)
        let mut jur = e.view("get_jurors", json!({})).await?;
        let mut gw = jur["gateway_key"].clone();
        if kind == "provider_tee" {
            jur["jurors"][idx]["pubkey"] = json!(pubkey);
        } else {
            gw = json!(pubkey);
        }
        e.owner
            .call(e.mg.id(), "set_jurors")
            .args_json(json!({"jurors": jur["jurors"], "gateway_key": gw}))
            .transact()
            .await?
            .into_result()?;
        let sig_b64 = b64(&decode64or_hex(sig["signature"].as_str().unwrap(), 64));
        let okv = e
            .view(
                "verify_ballot",
                json!({"juror_idx": idx, "kind": kind, "request_body": req, "response_body": resp, "signature": sig_b64}),
            )
            .await?;
        assert_eq!(okv, true, "recorded signature verifies on chain: {}", f.display());
        if r["synthetic"].as_bool().unwrap_or(false) {
            synthetic += 1
        } else {
            real += 1
        }
    }
    println!("t07: recorded ballots verified by the contract: {real} from NEAR AI, {synthetic} synthetic");
    Ok(())
}
