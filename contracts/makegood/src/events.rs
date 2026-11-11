//! NEP-297 events: `EVENT_JSON:{"standard","version","event","data":{...}}`.
use crate::consts::{EVENT_STANDARD, EVENT_VERSION};
use near_sdk::env;
use serde_json::{json, Value};

pub fn emit(event: &str, data: Value) {
    let v = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{}", v));
}
