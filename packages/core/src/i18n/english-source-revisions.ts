/**
 * SHA-256 of each Russian source locale after its English counterpart was
 * reviewed. When Russian copy changes, the localization test fails until the
 * matching English file is updated and this revision is refreshed.
 */
export const ENGLISH_SOURCE_REVISIONS = {
  "chat.json": "dc88acf09b8072477bed44445d041beca923b75abf40d40aca07922074ed970c",
  "common.json": "44b2d86b294a28d31c746866d068430ef1f9ed22f71e6e5b97cb7f9d61bd5249",
  "library.json": "3b40365c5a5a647181c8096bb3232b5b9c05efc66aa7523209a42cb97964e43a",
  "misc.json": "7b47e4fe8a63f11be0ff7b7a82f887bcb7ab65312f8f9ded55a95c6706eec7f7",
  "notes.json": "3737b673efeaff04113de518a4c0d237fe2f8858e6133998afa994871ec5380d",
  "onboarding.json": "691446f63699c6a6391e3adacc65f2a197943880cdfdf678e1383c8bc298a750",
  "profile.json": "8d29fc22f31cdb7b74b3e6d61980be6caa612a5747e8c67148a07a68a5245b74",
  "reader.json": "9ff9a95445dceff6d1e74dd1ab5176cd11e4e70aaeb53327acf80415378b2cd7",
  "settings.json": "d7ea3526cf6c5750d0d330dcfbb02396445175f6e1eabfc1ed96854383088d46",
  "stats.json": "3494f4ea5d32428462edbb41a005811b4614399be8391a31ac50592bba8ea48a",
  "translation.json": "d0808cbaae51cd2cfc017d0c0bec9c6fe482adfed8e23e4150a6c440af63aa49",
  "tts.json": "65d2e931451e14c341289cb6950e1fcd314b70853da5e0711fa512f75d8d350a",
} as const;
