// Turning what coordinators actually have into interest words that match.
//
// Fams are described by majors in shorthand ("PoliSci/Comm", "Cog Sci/Math",
// "Bio/Chem/Biochem") and alumni by a line about what they do ("Practicing
// internist", "Test engineer at a connector maker"). Matching only counts
// identical words, so both are brought to the same plain words: "polisci"
// becomes "political science", "internist" becomes "medicine".

/** Shorthand for majors, as students and coordinators write them. */
const MAJORS: [RegExp, string[]][] = [
  [/^poli\s*sci$|^polisci$|^political science$|^pols$/, ["political science"]],
  [/^comms?$|^communications?$|^comm studies$/, ["communications"]],
  [/^public affairs$|^pub affairs$/, ["public affairs"]],
  [/^cog\s*sci$|^cognitive science$/, ["cognitive science"]],
  [/^cs$|^comp\s*sci$|^computer science$/, ["computer science"]],
  [/^math(s|ematics)?$|^applied math(ematics)?$/, ["math"]],
  [/^stats?$|^statistics$/, ["statistics"]],
  [/^data( science)?$/, ["data"]],
  [/^ling(uistics)?$/, ["linguistics"]],
  [/^mc[bd][bd]$|^molecular biology$/, ["biology"]],
  [/^bio(logy)?$|^life sciences?$|^ibp$|^physio(logy)?$/, ["biology"]],
  [/^chem(istry)?$/, ["chemistry"]],
  [/^bio\s*chem(istry)?$/, ["biochemistry"]],
  [/^neuro(science)?$/, ["neuroscience", "biology"]],
  [/^psych(ology)?$|^psychobio(logy)?$/, ["psychology"]],
  [/^soc(iology)?$/, ["sociology"]],
  [/^anthro(pology)?$/, ["anthropology"]],
  [/^hist(ory)?$/, ["history"]],
  [/^humanities$|^english$|^philosophy$/, ["humanities"]],
  [/^econ(omics)?$/, ["economics"]],
  [/^biz\s*econ$|^business economics$/, ["economics", "business"]],
  [/^business$|^biz$/, ["business"]],
  [/^eng(ineering)?$|^engr$/, ["engineering"]],
  [/^ee$|^electrical engineering$/, ["engineering"]],
  [/^mech\s*e$|^mechanical engineering$|^aero(space)?( engineering)?$/, ["engineering"]],
  [/^pre-?med$/, ["pre-med", "medicine"]],
  [/^pre-?law$|^law$/, ["law"]],
  [/^public health$/, ["public health", "medicine"]],
  [/^nursing$/, ["nursing", "medicine"]],
  [/^education$|^ed$/, ["education"]],
  [/^physics$/, ["physics"]],
  [/^film$|^art$|^design$|^music$/, ["arts"]],
  [/^environmental science$|^environment$/, ["environment"]],
];

/** Plain interest words from a fam's majors, written any way: "PoliSci/Comm/Public Affairs". */
export function majorWords(text: string): string[] {
  const out: string[] = [];
  const parts = (text ?? "").split(/[/,;&+]|\s+x\s+\d*|\s*×\s*\d*|\band\b/i).map((p) => p.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean);
  for (const part of parts) {
    const hit = MAJORS.find(([re]) => re.test(part));
    for (const w of hit ? hit[1] : [part]) if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Work and study words in a line about an alum, and the interest words they stand for. */
const CAREERS: [RegExp, string[]][] = [
  [/internist|internal medicine|physician|\bdoctor\b|\bm\.?d\.?\b|med(ical)? (student|school)|residen(t|cy)/i, ["medicine", "biology", "pre-med"]],
  [/pharm|pharmacist|pharmacy/i, ["pharmacy", "chemistry", "biochemistry", "medicine"]],
  [/\bot\b|occupational therap/i, ["occupational therapy", "medicine", "psychology"]],
  [/\bpt\b|physical therap/i, ["physical therapy", "medicine", "biology"]],
  [/\bpa\b|physician assistant|orthopedic/i, ["medicine", "biology"]],
  [/nurs(e|ing)|nurse practitioner/i, ["nursing", "medicine"]],
  [/psychiatr|mental health|counsel/i, ["psychology", "medicine"]],
  [/aerospace|defen[sc]e/i, ["engineering", "physics"]],
  [/semiconductor|chip|electrical/i, ["engineering", "computer science"]],
  [/engineer/i, ["engineering"]],
  [/software|developer|programm/i, ["computer science", "engineering"]],
  [/data|database|analyst|analytics/i, ["data", "statistics", "computer science"]],
  [/nonprofit|non-profit|planned parenthood|fundrais|raised \$/i, ["public affairs", "sociology", "political science"]],
  [/policy|government|public service/i, ["political science", "public affairs"]],
  [/education|teach|school reform|academic|mentor/i, ["education", "humanities", "sociology"]],
  [/admissions|college counsel/i, ["education", "communications", "humanities"]],
  [/consult/i, ["business", "communications"]],
  [/law|attorney|lawyer|legal/i, ["law", "political science"]],
  [/financ|bank|account|invest/i, ["economics", "business"]],
  [/market|sales|startup|founder|entrepreneur/i, ["business", "communications"]],
  [/research|lab\b|scientist/i, ["biology", "chemistry"]],
  [/journalis|writer|media/i, ["communications", "humanities"]],
];

/** Interest words from a sentence about what an alum does. Empty when nothing is recognised. */
export function careerWords(text: string): string[] {
  const out: string[] = [];
  for (const [re, words] of CAREERS) if (re.test(text ?? "")) for (const w of words) if (!out.includes(w)) out.push(w);
  return out;
}
