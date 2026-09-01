/**
 * SHA-256 of each Russian source locale after its English counterpart was
 * reviewed. When Russian copy changes, the localization test fails until the
 * matching English file is updated and this revision is refreshed.
 */
export const ENGLISH_SOURCE_REVISIONS = {
  "chat.json": "d7e912b4f69342fc66bd686fd2dc47e9528fdbf6ff5e73224c7f39a633055177",
  "common.json": "9784e9ee5c59079279cb3120d8b7d23972d1451997ce320aa021690d8cc035b1",
  "library.json": "8b6210b40d116cb0ef4754e10cd0ef9e1f5e81ab1305835feda513e5359b5e54",
  "misc.json": "7b47e4fe8a63f11be0ff7b7a82f887bcb7ab65312f8f9ded55a95c6706eec7f7",
  "notes.json": "3737b673efeaff04113de518a4c0d237fe2f8858e6133998afa994871ec5380d",
  "onboarding.json": "691446f63699c6a6391e3adacc65f2a197943880cdfdf678e1383c8bc298a750",
  "profile.json": "7f64cf3d63d528b5016c75688ba8d8745397e999dc12c31b037355b164a35aed",
  "reader.json": "5a77936f0085686731e4a9978acbf743cbc56af0cd4da70aabd15c4c5602abb4",
  "settings.json": "d7ea3526cf6c5750d0d330dcfbb02396445175f6e1eabfc1ed96854383088d46",
  "stats.json": "3494f4ea5d32428462edbb41a005811b4614399be8391a31ac50592bba8ea48a",
  "translation.json": "d0808cbaae51cd2cfc017d0c0bec9c6fe482adfed8e23e4150a6c440af63aa49",
  "tts.json": "65d2e931451e14c341289cb6950e1fcd314b70853da5e0711fa512f75d8d350a",
} as const;
