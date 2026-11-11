// Fetch the NEAR AI Cloud attestation reports of the three jurors (each also carries
// the gateway's attestation) with signing_algo=ed25519 and a fresh nonce per request,
// save the raw bytes under fixtures/attestations/<UTC date>/, check that each TDX
// quote's REPORTDATA binds (key, nonce), and write fixtures/jurors.json.
// No API key needed (DESIGN 2.1).
//
//   npx tsx scripts/fetch-attestations.ts [--force]
import { fetchAttestations } from "./lib/attest.ts";
import { nearaiBaseUrl } from "./lib/nearai.ts";
import { parseArgs, repoPath, utcDate } from "./lib/util.ts";

const args = parseArgs();
const date = utcDate();
console.log(`Fetching 3 attestation reports from ${nearaiBaseUrl()} (signing_algo=ed25519, fresh nonce each)…`);
try {
  const out = await fetchAttestations({
    dir: repoPath("fixtures", "attestations", date),
    jurorsPath: repoPath("fixtures", "jurors.json"),
    force: args.force === true,
  });
  console.log(out.printed);
  console.log(`wrote fixtures/jurors.json and fixtures/attestations/${date}/`);
  if (out.problems.length) {
    console.error("PROBLEMS:\n  " + out.problems.join("\n  "));
    process.exit(1);
  }
  console.log("ATTESTATION OK (key and nonce bound in each TDX quote; certificate chains not verified, see docs/VERIFY.md)");
} catch (e) {
  console.error(`fetch-attestations: ${(e as Error).message}`);
  process.exit(1);
}
