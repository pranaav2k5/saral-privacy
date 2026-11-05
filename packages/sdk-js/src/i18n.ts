export type Locale = "en" | "hi";

export interface Strings {
  title: string;
  manageTitle: string;
  intro: string;
  rejectAll: string;
  acceptSelected: string;
  acceptAll: string;
  withdraw: string;
  changeChoice: string;
  close: string;
  opener: string;
  identifierLabel: string;
  identifierHint: string;
  on: string;
  off: string;
  refusedNote: string;
  savedNote: string;
  withdrawnNote: string;
  errNetwork: string;
  errSave: string;
  errAuth: string;
  errIdentifier: string;
  errNothing: string;
  errWithdraw: string;
}

/** The Hindi text is a draft that has not had a native-speaker or legal review (docs/compliance/notice-template-review.md). */
export const STRINGS: Record<Locale, Strings> = {
  en: {
    title: "Your privacy",
    manageTitle: "Your privacy choices",
    intro: "Choose what we may use your personal data for. Everything is off until you turn it on. You can withdraw your consent at any time.",
    rejectAll: "Reject all",
    acceptSelected: "Accept selected",
    acceptAll: "Accept all",
    withdraw: "Withdraw consent",
    changeChoice: "Change my choice",
    close: "Close",
    opener: "Privacy choices",
    identifierLabel: "Your email address or phone number",
    identifierHint: "It links your choice to you. We keep a keyed hash of it, not the address or number itself.",
    on: "On",
    off: "Off",
    refusedNote: "You rejected all purposes.",
    savedNote: "Your choice has been saved.",
    withdrawnNote: "Your consent has been withdrawn.",
    errNetwork: "We could not reach the server, so nothing was saved. Check your connection and try again.",
    errSave: "Your choice could not be saved. Please try again.",
    errAuth: "This site is not set up correctly, so your choice was not saved. Please tell the site owner.",
    errIdentifier: "Enter a valid email address or phone number (for example +919876543210).",
    errNothing: "Choose at least one purpose, or select Reject all.",
    errWithdraw: "Your consent could not be withdrawn. Check the email address or phone number and try again.",
  },
  hi: {
    title: "आपकी गोपनीयता",
    manageTitle: "आपकी गोपनीयता के विकल्प",
    intro: "तय करें कि हम आपके व्यक्तिगत डेटा का किन उद्देश्यों के लिए उपयोग कर सकते हैं। जब तक आप चालू नहीं करते, सब बंद है। आप कभी भी अपनी सहमति वापस ले सकते हैं।",
    rejectAll: "सभी अस्वीकार करें",
    acceptSelected: "चुने हुए स्वीकार करें",
    acceptAll: "सभी स्वीकार करें",
    withdraw: "सहमति वापस लें",
    changeChoice: "मेरा विकल्प बदलें",
    close: "बंद करें",
    opener: "गोपनीयता विकल्प",
    identifierLabel: "आपका ईमेल पता या फ़ोन नंबर",
    identifierHint: "इससे आपका विकल्प आपसे जुड़ता है। हम इसका एक कुंजी-आधारित हैश रखते हैं, पता या नंबर नहीं।",
    on: "चालू",
    off: "बंद",
    refusedNote: "आपने सभी उद्देश्य अस्वीकार किए।",
    savedNote: "आपका विकल्प सहेज लिया गया है।",
    withdrawnNote: "आपकी सहमति वापस ले ली गई है।",
    errNetwork: "हम सर्वर तक नहीं पहुँच सके, इसलिए कुछ सहेजा नहीं गया। अपना कनेक्शन जाँचें और दोबारा कोशिश करें।",
    errSave: "आपका विकल्प सहेजा नहीं जा सका। कृपया दोबारा कोशिश करें।",
    errAuth: "यह साइट सही ढंग से सेट नहीं है, इसलिए आपका विकल्प सहेजा नहीं गया। कृपया साइट के मालिक को बताएँ।",
    errIdentifier: "सही ईमेल पता या फ़ोन नंबर लिखें (जैसे +919876543210)।",
    errNothing: "कम से कम एक उद्देश्य चुनें, या सभी अस्वीकार करें चुनें।",
    errWithdraw: "आपकी सहमति वापस नहीं ली जा सकी। ईमेल पता या फ़ोन नंबर जाँचें और दोबारा कोशिश करें।",
  },
};
