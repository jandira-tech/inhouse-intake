import { polish } from "./llm.ts";

const result = await polish({
  requester_name: "jane smith",
  requester_email: "jane@acme.com",
  matter_type: "NDA",
  short_title: "acme nda renewal",
  description: "we need an nda with vendor x asap so we can share roadmap docs",
  urgency: "High",
  conflict_check_acknowledged: true,
  confidentiality_acknowledged: true,
});

console.log("=== POLISHED ===");
console.log(JSON.stringify(result.polished, null, 2));
console.log("\n=== SUGGESTIONS FOR EMPTY ===");
console.log(JSON.stringify(result.suggestions_for_empty, null, 2));
