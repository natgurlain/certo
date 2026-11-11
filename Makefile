# Pass extra flags with ARGS, e.g. `make demo ARGS=--keep-open`, `make testnet-demo ARGS=--dry-run`.
.PHONY: demo playground test guards verify build record killtest probe testnet-demo
demo:          ; npx tsx apps/demo/run.ts $(ARGS)
playground:    ; npx tsx apps/demo/run.ts --keep-open $(ARGS)
test:          ; npm test
guards:        ; npx tsx tests/guards/run.ts $(ARGS)
verify:        ; npx tsx scripts/verify-recorded.ts $(ARGS)
build:         ; ./scripts/build-contracts.sh
record:        ; npx tsx scripts/record.ts $(ARGS)
killtest:      ; npx tsx scripts/killtest.ts $(ARGS)
probe:         ; npx tsx scripts/probe.ts $(ARGS)
testnet-demo:  ; NEAR_NETWORK=testnet npx tsx apps/demo/run.ts $(ARGS)
