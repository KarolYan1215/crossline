import { expect, test } from "vitest";
import {
  cleanFolderNames, cleanFolderRules, credentialName, credentialText, excludedByRules, folderGroup, folderPatternMatches, groupPattern, nameWords,
  sensitiveName, sensitiveText
} from "./source-folders";

test("a file name is read as words across camelCase, digits and punctuation", () => {
  expect(nameWords("YanKai9262026TaxDocs.pdf")).toBe(" yan kai 9262026 tax docs pdf ");
  expect(nameWords("APIKey_v2.txt")).toBe(" api key v 2 txt ");
  expect(nameWords("[颜开_2254009]AIGC检测报告.pdf")).toBe(" 颜开 2254009 aigc 检测报告 pdf ");
});

// Every name the owner's real Downloads held that the first rules missed (2026-10-15), and the course files that must stay readable.
const CREDENTIALS = ["AccessKey.txt", "默认业务空间-apiKey-5728154.csv", "默认业务空间-apiKey-5705316.csv", "api_key.txt", "my-api-key.md",
  "access_key.csv", "aws secret.txt", "github token.txt", "credentials.json.txt", "passwords.txt", "服务器私钥.txt", "server.pem", "cert.p12",
  "id.pfx", "deploy.key", ".env", "config/.env.local", "github recovery codes.txt", "备用密码.txt"];
const SENSITIVE: Array<[string, string]> = [
  ["YanKai9262026TaxDocs.pdf", "税表"], ["YanKai8252026TaxDocs.pdf", "税表"], ["W-2 2023.pdf", "税表"], ["Form 1040.pdf", "税表"], ["个税年度汇算.pdf", "税表"],
  ["IMM5740_1-17MP1LFE.pdf", "移民与签证"], ["IMM5756_1-16PBVQV2.pdf", "移民与签证"], ["IMM5739_1-16PBVQTI.pdf", "移民与签证"],
  ["I901_payment_confirmation_04202026.PDF", "移民与签证"], ["I901_payment_coupon_04202026.PDF", "移民与签证"], ["I-20 signed.pdf", "移民与签证"],
  ["F1 Visa.pdf", "移民与签证"], ["SEVIS fee.pdf", "移民与签证"], ["DS-160 confirmation.pdf", "移民与签证"], ["Study Permit.pdf", "移民与签证"],
  ["PAYMENT_RECEIPT_1712712392.pdf", "付款与收据"], ["报价单.pdf", "付款与收据"], ["Invoice 2026-03.pdf", "付款与收据"], ["学费缴费.pdf", "付款与收据"], ["91320191MA1XM5TX71_26080616153943920580.pdf", "付款与收据"],
  ["Dental_-_Uniform_-_Delta_Dental.pdf", "保险与医疗"], ["ConsentForm_-TTS-English-IN-VAC-Final__1_.pdf", "保险与医疗"],
  ["Vaccination Disclosure Requirement zh-Hans.pdf", "保险与医疗"], ["health insurance card.pdf", "保险与医疗"], ["体检报告.pdf", "保险与医疗"],
  ["Onboarding_for_Kai_Yan.pdf", "录用与薪资"], ["CC004028 Yan_ Kai Fall 26 Fellowship.pdf", "录用与薪资"], ["Offer Letter.pdf", "录用与薪资"],
  ["MV1 Application.pdf", "车辆与证件申请"], ["申请表.docx", "车辆与证件申请"],
  ["免费_PDF打印版_查重报告_[颜开_2254009].pdf", "个人档案"], ["免费_PDF打印版_AIGC检测报告_[颜开_2254009].pdf", "个人档案"],
  ["免费_Word标红版_AIGC检测报告_[颜开_2254009].docx", "个人档案"], ["217957be-颜开_2254009.docx-AIGC报告单.pdf", "个人档案"], ["-AIGC报告单.pdf", "个人档案"],
  ["2254009-颜开-抑制性作用调控癫痫的复杂动力学研究-综合智评报告单.pdf", "个人档案"],
  ["20260129190544158678_颜开2254009毕业论文开题报告.doc", "个人档案"], ["20260129190544158678_颜开2254009毕业论文开题报告 (1).doc", "个人档案"],
  ["20260129190544158678_颜开2254009毕业论文开题报告 (2).doc", "个人档案"],
  ["Affidavit of Financial Support_UW Madison_2019.pdf", "资金证明"], ["Apply for a Social Security Card.pdf", "社安号"],
  ["Passport_scan.pdf", "证件"], ["驾照正反面.pdf", "证件"], ["Driver's License.pdf", "证件"], ["Chase bank statement 2024-03.pdf", "银行与流水"],
  ["工资流水.pdf", "银行与流水"], ["Apartment Lease 2025.pdf", "合同与租约"], ["租房合同.docx", "合同与租约"],
  ["I-94_I-95 Official Website - Get Most Recent Response.pdf", "移民与签证"], ["Enrollment_verification.pdf", "个人档案"],
  ["CC004028 Yan, Karol 10025878  Employment verification letter 9.10.2026.pdf", "个人档案"], ["EE_BENEFIT_SUMMARY.pdf", "保险与医疗"],
  ["my_ssn.pdf", "社安号"]
];
const COURSE = ["ECE_548_Homework-1.pdf", "S1-IntroductionF26.pdf", "Notes_Set_1.pdf", "F26-ECE555-Syllabus.pdf",
  "Physics of Semiconductor Devices (Sze, 3rd ed).pdf", "syntax notes.md", "release notes.md", "visual design.pdf", "密码学讲义.pdf",
  "流水线设计.pdf", "ECE 548 HW2.pdf", "Lecture 20.pdf", "Week 2 notes.md", "Chapter 10 Problems.pdf", "实验报告20260115.pdf", "s41467-025-58005-z.pdf",
  "6a8caffe0257e706bde568ad.pdf", "ECE555-F26-Homework2 (1).docx", "S3-Short_Channel_effects_and_Advanced_MOSFETSF26.pdf", "同济大学VPN使用说明.pdf",
  "Meeting (Weekly and Monthly)/Presentation Slides/February_16_2024_Memory-Based-Learning-SSN-HDC.pptx"];

test("credentials are recognised by name, extension and content, and nothing else is", () => {
  for (const name of CREDENTIALS) expect([name, credentialName(name)]).toEqual([name, "凭据"]);
  for (const [name] of SENSITIVE) expect([name, credentialName(name)]).toEqual([name, undefined]);
  for (const name of COURSE) expect([name, credentialName(name)]).toEqual([name, undefined]);
  expect(credentialText("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx")).toBe("凭据");
  expect(credentialText("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")).toBe("凭据");
  expect(credentialText("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("凭据");
  expect(credentialText("xoxb-123456-abcdef-ghijk")).toBe("凭据");
  expect(credentialText("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r")).toBe("凭据");
  expect(credentialText("AccessKeySecret,LTAI5tQ8xYz3abcdefghijklmnopqrstuvwx")).toBe("凭据");
  expect(credentialText("key: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe("凭据");
  // A hash in prose with no key wording, and the word 'key' with nothing key-like, are not credentials.
  expect(credentialText("checksum 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBeUndefined();
  expect(credentialText("The key idea of chapter 3 is that a p-n junction rectifies.")).toBeUndefined();
});

test("private papers are recognised by the words of their names, camelCase and digits split", () => {
  for (const [name, expected] of SENSITIVE) expect([name, sensitiveName(name)]).toEqual([name, expected]);
  for (const name of COURSE) expect([name, sensitiveName(name)]).toEqual([name, undefined]);
});

test("the person's own names mark a record that carries them with a long number, and only then", () => {
  expect(sensitiveName("Kai Yan 2254009 transcript.pdf", ["Kai Yan"])).toBe("个人档案");
  expect(sensitiveName("Yan_Kai_2254009.pdf", ["Kai Yan"])).toBe("个人档案");
  expect(sensitiveName("Kai Yan 2254009 transcript.pdf")).toBeUndefined();
  expect(sensitiveName("Kai Yan notes.pdf", ["Kai Yan"])).toBeUndefined();
  expect(sensitiveName("Kai Yan 20260115.pdf", ["Kai Yan"])).toBeUndefined(); // a date is not an ID
  expect(sensitiveName("项目/颜开 简历 12345678.pdf", ["颜开"])).toBe("个人档案");
  expect(cleanFolderNames([" Kai Yan ", "Kai Yan", "x", 3, "颜开"])).toEqual(["Kai Yan", "颜开"]);
});

test("IDs and account numbers in a file's opening mark it, with their check digits honoured", () => {
  expect(sensitiveText("Name: Ann\nSSN 123-45-6789\n")).toBe("社安号");
  expect(sensitiveText("身份证号：11010519491231002X")).toBe("身份证号");
  expect(sensitiveText("身份证号：110105194912310021")).toBeUndefined(); // wrong check digit
  expect(sensitiveText("卡号 6222 0212 3456 7890 128")).toBeUndefined(); // fails Luhn
  expect(sensitiveText("Card 4111 1111 1111 1111 exp 12/27")).toBe("银行卡号");
  expect(sensitiveText("call 608-262-1234 on 2026-10-15; DOI 10.1109/5.771073")).toBeUndefined();
  // Only the opening is read.
  expect(sensitiveText(`${"x".repeat(2100)} 123-45-6789`)).toBeUndefined();
});

test("an exclusion is a path, a subfolder or a glob", () => {
  expect(folderPatternMatches("Tax 2019", "Tax 2019/a.pdf")).toBe(true);
  expect(folderPatternMatches("Tax 2019", "Tax 2019")).toBe(true);
  expect(folderPatternMatches("Tax", "Tax 2019/a.pdf")).toBe(false);
  expect(folderPatternMatches("old\\notes.md", "old/notes.md")).toBe(true);
  expect(folderPatternMatches("*.zip.pdf", "x.zip.pdf")).toBe(true);
  expect(folderPatternMatches("*.pdf", "sub/x.pdf")).toBe(false);
  expect(folderPatternMatches("**/*.pdf", "sub/deep/x.pdf")).toBe(true);
  expect(folderPatternMatches("**/*.pdf", "x.pdf")).toBe(true);
  expect(folderPatternMatches("课程/**", "课程/a/b.md")).toBe(true);
  expect(folderPatternMatches("开题报告 (?).doc", "开题报告 (1).doc")).toBe(true);
  expect(folderPatternMatches("A.PDF", "a.pdf")).toBe(true);
  // The root group: the folder's own files, not its subfolders.
  expect(excludedByRules("a.pdf", [groupPattern("")])).toBe(true);
  expect(excludedByRules("sub/a.pdf", [groupPattern("")])).toBe(false);
  expect(excludedByRules("sub/", [groupPattern("")])).toBe(false);
  expect(excludedByRules("sub/", [groupPattern("sub")])).toBe(true);
  expect(folderGroup("sub\\deep\\a.pdf")).toBe("sub");
  expect(folderGroup("a.pdf")).toBe("");
});

test("stored rules are relative, unique and bounded", () => {
  expect(cleanFolderRules({ exclude: [" sub\\deep/ ", "sub/deep", "C:\\Windows", "../up", "", 3], include: "x" }))
    .toEqual({ exclude: ["sub/deep"], include: [] });
});
