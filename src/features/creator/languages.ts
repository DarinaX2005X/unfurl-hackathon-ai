export const courseLanguages = [
  { value: "en", label: "English" }, { value: "ru", label: "Russian" },
  { value: "kk", label: "Kazakh" }, { value: "es", label: "Spanish" },
  { value: "fr", label: "French" }, { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" }, { value: "it", label: "Italian" },
  { value: "zh", label: "Chinese" }, { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" }, { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" }, { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
];

export function languageLabel(language: string): string {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
}

export function languageOptions(selected: string): typeof courseLanguages {
  return courseLanguages.some((option) => option.value === selected)
    ? courseLanguages : [...courseLanguages, { value: selected, label: languageLabel(selected) }];
}
