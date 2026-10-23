// Sign-up forms with a fixed list of fields, so alumni and students pick from
// the same words and their answers match exactly. Free-text tags are the
// biggest risk to good matches: "STEM" never matches "mechanical
// engineering". The script below makes both Google Forms in the
// coordinator's own Google account; the answers export as CSV and upload
// here with no column matching to do.

import fieldsText from "../../templates/fields.txt";

export const FIELDS: string[] = fieldsText.split(/\r?\n/).map((x) => x.trim()).filter((x) => x);

// Question titles, chosen so the upload recognizes each column by itself.
export const HOST_QUESTIONS = {
  name: "Your name",
  table: "Host table name (your field, for example Pharmacy)",
  fields: "Which fields can you talk about?",
};
export const STUDENT_QUESTIONS = {
  name: "Your name",
  fam: "Which fam are you in?",
  fields: "Your intended major and fields of interest",
};

const js = (s: string) => JSON.stringify(s);

/** A Google Apps Script that creates both forms. Paste into script.google.com and click Run. */
export function formsScript(eventName: string): string {
  const title = eventName.trim() || "Alumni dinner";
  return `// Makes two Google Forms for ${title.replace(/\n/g, " ")}: one for alumni hosts, one for students.
// 1. Go to https://script.google.com and click New project.
// 2. Delete what is there, paste all of this, and click Run.
// 3. Allow access when Google asks (the script only creates two forms in your Drive).
// 4. The links to both forms are in the Execution log at the bottom.
// When answers are in: in each form, Responses, then the three dots, then
// Download responses (.csv). Upload the CSV in Rotation Optimizer.

const FIELDS = ${JSON.stringify(FIELDS, null, 2)};

function makeForms() {
  const hosts = FormApp.create(${js(`${title}: alumni host sign-up`)});
  hosts.setDescription("Thank you for hosting. We match each host table to student groups who share your fields.");
  hosts.setCollectEmail(false);
  hosts.addTextItem().setTitle(${js(HOST_QUESTIONS.name)}).setRequired(true);
  hosts.addTextItem().setTitle(${js(HOST_QUESTIONS.table)}).setRequired(true);
  hosts.addCheckboxItem().setTitle(${js(HOST_QUESTIONS.fields)})
    .setHelpText("Pick every field you are happy to talk about.").setChoiceValues(FIELDS).showOtherOption(true).setRequired(true);

  const students = FormApp.create(${js(`${title}: student sign-up`)});
  students.setDescription("Tell us what you are interested in, so we can match you with alumni in those fields.");
  students.setCollectEmail(false);
  students.addTextItem().setTitle(${js(STUDENT_QUESTIONS.name)}).setRequired(true);
  students.addTextItem().setTitle(${js(STUDENT_QUESTIONS.fam)}).setRequired(true);
  students.addCheckboxItem().setTitle(${js(STUDENT_QUESTIONS.fields)})
    .setHelpText("Pick all that apply.").setChoiceValues(FIELDS).showOtherOption(true).setRequired(true);

  Logger.log("Alumni form: " + hosts.getPublishedUrl());
  Logger.log("Student form: " + students.getPublishedUrl());
  Logger.log("Edit them here: " + hosts.getEditUrl() + " and " + students.getEditUrl());
}
`;
}
