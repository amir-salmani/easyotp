/**
 * What two people compare at the end of a pairing: a colour and a thing.
 *
 * 8 colours and 64 things give 512 combinations. Each is named in Persian and
 * English, because the comparison happens aloud, on a phone call, possibly
 * between two people reading different languages. Every word was chosen to be
 * said and understood without spelling it.
 *
 * The order of both lists is part of the protocol. The Host shows the same
 * indexes, so an entry may be reworded but never moved, added or removed
 * without changing the protocol's version.
 */
export interface Named {
  fa: string;
  en: string;
}

export const COLOURS: ReadonlyArray<Named & { css: string }> = [
  { fa: "قرمز", en: "red", css: "#c62828" },
  { fa: "آبی", en: "blue", css: "#1565c0" },
  { fa: "سبز", en: "green", css: "#2e7d32" },
  { fa: "زرد", en: "yellow", css: "#f9a825" },
  { fa: "نارنجی", en: "orange", css: "#ef6c00" },
  { fa: "بنفش", en: "purple", css: "#6a1b9a" },
  { fa: "سیاه", en: "black", css: "#212121" },
  { fa: "سفید", en: "white", css: "#fafafa" },
];

export const THINGS: ReadonlyArray<Named & { emoji: string }> = [
  { fa: "سیب", en: "apple", emoji: "🍎" },
  { fa: "موز", en: "banana", emoji: "🍌" },
  { fa: "انگور", en: "grapes", emoji: "🍇" },
  { fa: "هندوانه", en: "watermelon", emoji: "🍉" },
  { fa: "لیمو", en: "lemon", emoji: "🍋" },
  { fa: "گیلاس", en: "cherry", emoji: "🍒" },
  { fa: "توت‌فرنگی", en: "strawberry", emoji: "🍓" },
  { fa: "هویج", en: "carrot", emoji: "🥕" },
  { fa: "نان", en: "bread", emoji: "🍞" },
  { fa: "تخم‌مرغ", en: "egg", emoji: "🥚" },
  { fa: "قارچ", en: "mushroom", emoji: "🍄" },
  { fa: "ذرت", en: "corn", emoji: "🌽" },
  { fa: "گربه", en: "cat", emoji: "🐈" },
  { fa: "سگ", en: "dog", emoji: "🐕" },
  { fa: "اسب", en: "horse", emoji: "🐎" },
  { fa: "گاو", en: "cow", emoji: "🐄" },
  { fa: "گوسفند", en: "sheep", emoji: "🐑" },
  { fa: "مرغ", en: "chicken", emoji: "🐔" },
  { fa: "ماهی", en: "fish", emoji: "🐟" },
  { fa: "پرنده", en: "bird", emoji: "🐦" },
  { fa: "خرگوش", en: "rabbit", emoji: "🐇" },
  { fa: "فیل", en: "elephant", emoji: "🐘" },
  { fa: "شیر", en: "lion", emoji: "🦁" },
  { fa: "شتر", en: "camel", emoji: "🐪" },
  { fa: "لاک‌پشت", en: "turtle", emoji: "🐢" },
  { fa: "پروانه", en: "butterfly", emoji: "🦋" },
  { fa: "زنبور", en: "bee", emoji: "🐝" },
  { fa: "مورچه", en: "ant", emoji: "🐜" },
  { fa: "گل", en: "flower", emoji: "🌷" },
  { fa: "درخت", en: "tree", emoji: "🌳" },
  { fa: "برگ", en: "leaf", emoji: "🍃" },
  { fa: "خورشید", en: "sun", emoji: "☀️" },
  { fa: "ماه", en: "moon", emoji: "🌙" },
  { fa: "ستاره", en: "star", emoji: "⭐" },
  { fa: "ابر", en: "cloud", emoji: "☁️" },
  { fa: "چتر", en: "umbrella", emoji: "☂️" },
  { fa: "کوه", en: "mountain", emoji: "⛰️" },
  { fa: "خانه", en: "house", emoji: "🏠" },
  { fa: "در", en: "door", emoji: "🚪" },
  { fa: "کلید", en: "key", emoji: "🔑" },
  { fa: "قفل", en: "lock", emoji: "🔒" },
  { fa: "چراغ", en: "lamp", emoji: "💡" },
  { fa: "ساعت", en: "clock", emoji: "⏰" },
  { fa: "کتاب", en: "book", emoji: "📕" },
  { fa: "مداد", en: "pencil", emoji: "✏️" },
  { fa: "قیچی", en: "scissors", emoji: "✂️" },
  { fa: "عینک", en: "glasses", emoji: "👓" },
  { fa: "کلاه", en: "hat", emoji: "🎩" },
  { fa: "کفش", en: "shoe", emoji: "👞" },
  { fa: "کیف", en: "bag", emoji: "👜" },
  { fa: "صندلی", en: "chair", emoji: "🪑" },
  { fa: "تخت", en: "bed", emoji: "🛏️" },
  { fa: "فنجان", en: "cup", emoji: "☕" },
  { fa: "قاشق", en: "spoon", emoji: "🥄" },
  { fa: "تلفن", en: "telephone", emoji: "☎️" },
  { fa: "ماشین", en: "car", emoji: "🚗" },
  { fa: "اتوبوس", en: "bus", emoji: "🚌" },
  { fa: "دوچرخه", en: "bicycle", emoji: "🚲" },
  { fa: "هواپیما", en: "airplane", emoji: "✈️" },
  { fa: "قایق", en: "boat", emoji: "⛵" },
  { fa: "قطار", en: "train", emoji: "🚂" },
  { fa: "توپ", en: "ball", emoji: "⚽" },
  { fa: "بادکنک", en: "balloon", emoji: "🎈" },
  { fa: "زنگ", en: "bell", emoji: "🔔" },
];

export interface Picture {
  colour: number;
  thing: number;
}

/** Both lists have a power-of-two length, so taking a byte modulo the length is unbiased. */
export const pictureFrom = (digest: Uint8Array): Picture => ({
  colour: digest[0]! % COLOURS.length,
  thing: digest[1]! % THINGS.length,
});
