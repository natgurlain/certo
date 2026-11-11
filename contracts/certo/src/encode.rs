//! Canonical encodings (DESIGN 4.3, 4.4). Mirrored byte for byte by
//! `packages/core`; golden vectors in `fixtures/vectors.json`.
use crate::consts::{RECEIPT_PREFIX, SYSTEM_PROMPT};

/// `esc(s)`: what `JSON.stringify` does to a string, without the outer quotes.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let v = c as u32;
                out.push_str("\\u00");
                out.push(HEX[(v >> 4) as usize] as char);
                out.push(HEX[(v & 0xf) as usize] as char);
            }
            c => out.push(c),
        }
    }
    out
}

/// Which offer juror `idx` sees as X: the buyer's for jurors 0 and 2, the seller's for juror 1.
pub fn buyer_is_x(juror_idx: usize) -> bool {
    juror_idx != 1
}

/// The exact chat-completion request body sent to juror `juror_idx`.
pub fn panel_request_body(
    juror_idx: usize,
    model_id: &str,
    terms_text: &str,
    request_canon: &str,
    response_body: &str,
    buyer_bps: u16,
    seller_bps: u16,
) -> String {
    let (x, y) = if buyer_is_x(juror_idx) { (buyer_bps, seller_bps) } else { (seller_bps, buyer_bps) };
    let case = format!(
        "{{\"terms\":\"{}\",\"request\":\"{}\",\"response\":\"{}\",\"offer_X\":\"refund {} percent of the price\",\"offer_Y\":\"refund {} percent of the price\"}}",
        esc(terms_text),
        esc(request_canon),
        esc(response_body),
        x / 100,
        y / 100
    );
    format!(
        "{{\"model\":\"{}\",\"messages\":[{{\"role\":\"system\",\"content\":\"{}\"}},{{\"role\":\"user\",\"content\":\"{}\"}}],\"temperature\":0,\"seed\":7,\"max_tokens\":600,\"stream\":false}}",
        esc(model_id),
        esc(SYSTEM_PROMPT),
        esc(&case)
    )
}

/// Seller receipt text (DESIGN 4.3).
#[allow(clippy::too_many_arguments)]
pub fn receipt_text(
    contract: &str,
    call_id: &str,
    buyer: &str,
    price: u128,
    terms_id: &str,
    request_hash: &[u8; 32],
    response_hash: &[u8; 32],
    status_code: u16,
    served_at_ms: u64,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        RECEIPT_PREFIX,
        contract,
        call_id,
        buyer,
        price,
        terms_id,
        to_hex(request_hash),
        to_hex(response_hash),
        status_code,
        served_at_ms
    )
}

/// Text a juror signs: `provider_tee` → `<model>:<req>:<resp>`, `gateway` → `<req>:<resp>`.
pub fn ballot_text(model_id: Option<&str>, request_sha: &[u8; 32], response_sha: &[u8; 32]) -> String {
    match model_id {
        Some(m) => format!("{}:{}:{}", m, to_hex(request_sha), to_hex(response_sha)),
        None => format!("{}:{}", to_hex(request_sha), to_hex(response_sha)),
    }
}

/// Offer commitment preimage: `u16_le(offer_bps) ‖ salt[32]`.
pub fn commit_preimage(offer_bps: u16, salt: &[u8; 32]) -> [u8; 34] {
    let mut b = [0u8; 34];
    b[..2].copy_from_slice(&offer_bps.to_le_bytes());
    b[2..].copy_from_slice(salt);
    b
}

/// Panel output parsing (DESIGN 4.4). `Some(true)` = X, `Some(false)` = Y, `None` = abstain.
/// Never panics.
pub fn parse_vote(response_body: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(response_body).ok()?;
    let content = v.get("choices")?.get(0)?.get("message")?.get("content")?.as_str()?;
    let mut s = content;
    if let Some(rest) = s.strip_prefix("<think>") {
        let end = rest.find("</think>")?;
        s = &rest[end + "</think>".len()..];
    }
    match s.trim_matches(is_ascii_ws) {
        "X" => Some(true),
        "Y" => Some(false),
        _ => None,
    }
}

fn is_ascii_ws(c: char) -> bool {
    c.is_ascii_whitespace()
}

pub fn to_hex(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(HEX[(x >> 4) as usize] as char);
        s.push(HEX[(x & 0xf) as usize] as char);
    }
    s
}

/// Lower-case hex of exactly N bytes.
pub fn from_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let b = s.as_bytes();
    if b.len() != 2 * N {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = (nib(b[2 * i])? << 4) | nib(b[2 * i + 1])?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esc_matches_json_stringify() {
        assert_eq!(esc("a\"b\\c"), "a\\\"b\\\\c");
        assert_eq!(esc("\u{08}\u{0c}\n\r\t"), "\\b\\f\\n\\r\\t");
        assert_eq!(esc("\u{00}\u{1f}\u{0b}"), "\\u0000\\u001f\\u000b");
        assert_eq!(esc("\u{7f}\u{2028}é😀/"), "\u{7f}\u{2028}é😀/");
        // serde_json agrees with JSON.stringify on everything esc covers.
        for s in ["x\"y", "\\", "\u{01}\u{1a}", "line\nbreak", "😀\u{2029}", "</script>"] {
            let j = serde_json::to_string(s).unwrap();
            assert_eq!(esc(s), &j[1..j.len() - 1], "{s:?}");
        }
    }

    #[test]
    fn panel_body_shape_and_label_mapping() {
        let b0 = panel_request_body(0, "m/a", "T", "GET\n/x\n", "{\"a\":1}", 10000, 0);
        let b1 = panel_request_body(1, "m/b", "T", "GET\n/x\n", "{\"a\":1}", 10000, 0);
        assert!(b0.starts_with("{\"model\":\"m/a\",\"messages\":[{\"role\":\"system\",\"content\":\"You are one of three"));
        assert!(b0.ends_with("}\"}],\"temperature\":0,\"seed\":7,\"max_tokens\":600,\"stream\":false}"));
        assert!(b0.contains("\\\"offer_X\\\":\\\"refund 100 percent of the price\\\",\\\"offer_Y\\\":\\\"refund 0 percent"));
        assert!(b1.contains("\\\"offer_X\\\":\\\"refund 0 percent of the price\\\",\\\"offer_Y\\\":\\\"refund 100 percent"));
        // evidence is escaped twice
        assert!(b0.contains("\\\"response\\\":\\\"{\\\\\\\"a\\\\\\\":1}\\\""));
        // whole body is valid JSON and the user content parses back to the CASE object
        let v: serde_json::Value = serde_json::from_str(&b0).unwrap();
        assert_eq!(v["messages"][0]["content"], SYSTEM_PROMPT);
        let case: serde_json::Value = serde_json::from_str(v["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(case["response"], "{\"a\":1}");
        assert_eq!(case["request"], "GET\n/x\n");
    }

    #[test]
    fn system_prompt_is_one_ascii_line() {
        assert!(SYSTEM_PROMPT.is_ascii() && !SYSTEM_PROMPT.contains('\n'));
        assert!(SYSTEM_PROMPT.ends_with("Reply with exactly one character, X or Y, and nothing else."));
        assert_eq!(SYSTEM_PROMPT.len(), 1162);
    }

    #[test]
    fn receipt_text_format() {
        let t = receipt_text("c.near", "s.near/00", "b.near", 400_000, "t-1", &[0xab; 32], &[0x01; 32], 200, 17);
        assert_eq!(
            t,
            format!("certo-receipt:v1|c.near|s.near/00|b.near|400000|t-1|{}|{}|200|17", "ab".repeat(32), "01".repeat(32))
        );
    }

    #[test]
    fn parse_vote_cases() {
        let w = |c: &str| serde_json::json!({"choices":[{"message":{"content":c}}]}).to_string();
        assert_eq!(parse_vote(&w("X")), Some(true));
        assert_eq!(parse_vote(&w(" Y\n")), Some(false));
        assert_eq!(parse_vote(&w("<think>hmm X? no</think>\n\nY")), Some(false));
        assert_eq!(parse_vote(&w("\n<think>a</think>X")), None); // the block must open at byte 0
        assert_eq!(parse_vote(&w("<think>a</think><think>b</think>X")), None);
        assert_eq!(parse_vote(&w("<think>unterminated X")), None);
        assert_eq!(parse_vote(&w("x")), None);
        assert_eq!(parse_vote(&w("X.")), None);
        assert_eq!(parse_vote(&w("XY")), None);
        assert_eq!(parse_vote(&w("")), None);
        assert_eq!(parse_vote("not json"), None);
        assert_eq!(parse_vote("{\"choices\":[]}"), None);
        assert_eq!(parse_vote("{\"choices\":[{\"message\":{\"content\":null}}]}"), None);
        assert_eq!(parse_vote("{\"choices\":[{\"message\":{\"content\":7}}]}"), None);
        assert_eq!(parse_vote("[1,2]"), None);
    }

    #[test]
    fn hex_roundtrip() {
        let b = [0u8, 1, 0xfe, 0xff];
        assert_eq!(to_hex(&b), "0001feff");
        assert_eq!(from_hex::<4>("0001feff"), Some(b));
        assert_eq!(from_hex::<4>("0001FEFF"), None);
        assert_eq!(from_hex::<4>("0001fe"), None);
    }

    #[test]
    fn commit_preimage_layout() {
        let p = commit_preimage(0x1234, &[7; 32]);
        assert_eq!(&p[..2], &[0x34, 0x12]);
        assert_eq!(&p[2..], &[7; 32]);
    }
}
