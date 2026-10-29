/**
 * Store Sections: the Buy lines grouped the way a Swedish grocery store is walked, produce first
 * and household last. Deterministic, from the line's name alone, in Swedish and English: the
 * longest known word a name's words end with decides (Swedish compounds end in their head word, so
 * "nötfärs" is färs and "olivolja" is olja). A name with no known word lands in Övrigt.
 */
import { normaliseName } from "../text.js";

/** In walking order. */
export const STORE_SECTIONS = ["produce", "bread", "meat", "dairy", "dry", "frozen", "household", "other"] as const;

export type StoreSection = (typeof STORE_SECTIONS)[number];

const WORDS: Record<Exclude<StoreSection, "other">, string[]> = {
  produce: [
    "frukt", "grönsaker", "äpple", "äpplen", "päron", "banan", "bananer", "apelsin", "apelsiner", "citron", "citroner", "lime", "clementin", "clementiner", "mandarin",
    "vindruvor", "druvor", "melon", "avokado", "tomat", "tomater", "körsbärstomater", "gurka", "paprika", "sallad", "spenat", "ruccola", "kål", "broccoli",
    "morot", "morötter", "palsternacka", "rödbetor", "potatis", "lök", "ingefära", "chili", "svamp", "champinjoner", "zucchini", "aubergine", "majskolv",
    "dill", "persilja", "basilika", "koriander", "gräslök", "bär", "jordgubbar", "blåbär", "hallon", "sparris", "selleri", "rädisor", "kiwi", "mango", "ananas",
    "apple", "apples", "banana", "bananas", "orange", "oranges", "lemon", "lemons", "grapes", "avocado", "tomato", "tomatoes", "cucumber", "lettuce",
    "spinach", "cabbage", "cauliflower", "carrot", "carrots", "potato", "potatoes", "onion", "onions", "garlic", "ginger", "mushrooms", "courgette",
    "parsley", "coriander", "basil", "berries", "strawberries", "celery", "leek",
  ],
  bread: ["bröd", "limpa", "baguette", "fralla", "frallor", "tortilla", "tortillas", "knäckebröd", "kavring", "bullar", "bread", "buns", "bun", "wraps", "bagels"],
  meat: [
    "kött", "färs", "biff", "entrecote", "fläsk", "karré", "kotlett", "kotletter", "kyckling", "filé", "kalkon", "lamm", "bacon", "skinka", "korv", "chorizo",
    "salami", "kassler", "lax", "torsk", "sej", "fisk", "räkor", "köttbullar", "pålägg",
    "beef", "mince", "pork", "chicken", "turkey", "lamb", "ham", "sausage", "sausages", "salmon", "cod", "fish", "prawns", "shrimp",
  ],
  dairy: [
    "mjölk", "fil", "grädde", "fraiche", "yoghurt", "kvarg", "keso", "smör", "margarin", "ost", "parmesan", "mozzarella", "cheddar", "halloumi", "feta",
    "ricotta", "mascarpone", "ägg", "jäst", "milk", "cream", "yogurt", "butter", "cheese", "egg", "eggs", "yeast",
  ],
  dry: [
    "mjöl", "socker", "salt", "peppar", "krydda", "kryddor", "pulver", "pasta", "spaghetti", "makaroner", "nudlar", "ris", "couscous", "bulgur", "quinoa",
    "gryn", "flingor", "müsli", "buljong", "fond", "olja", "vinäger", "ättika", "soja", "ketchup", "senap", "majonnäs", "tacoskal", "salsa", "passata",
    "puré", "bönor", "linser", "kikärtor", "majs", "tonfisk", "kokosmjölk", "honung", "sylt", "kaffe", "te", "kakao", "choklad", "nötter", "mandel",
    "russin", "bakpulver", "chips", "flour", "sugar", "pepper", "spices", "noodles", "rice", "oats", "stock", "oil", "vinegar", "mustard", "beans",
    "lentils", "chickpeas", "coffee", "tea", "honey", "jam",
  ],
  frozen: ["glass", "fryst", "frysta", "frozen"],
  household: [
    "blöjor", "tandkräm", "tandborste", "toapapper", "hushållspapper", "diskmedel", "tvättmedel", "schampo", "tvål", "soppåsar", "servetter", "batterier",
    "nappies", "diapers", "toothpaste", "soap", "detergent", "shampoo",
  ],
};

/** Words that put the whole name in one section whatever its head word is: "krossade tomater" is a tin. */
const OVERRIDES: Record<string, StoreSection> = {
  krossade: "dry", krossad: "dry", burk: "dry", konserverade: "dry", canned: "dry", tinned: "dry",
  fryst: "frozen", frysta: "frozen", djupfryst: "frozen", frozen: "frozen", ice: "frozen",
};

const BY_WORD = new Map<string, StoreSection>(Object.entries(WORDS).flatMap(([section, words]) => words.map((w) => [w, section as StoreSection] as const)));
const LONGEST_FIRST = [...BY_WORD.keys()].sort((a, b) => b.length - a.length);

/** The section of one word: an exact match, else the longest known word (three letters or more) it ends with. */
function sectionOfWord(word: string): StoreSection | undefined {
  const exact = BY_WORD.get(word);
  if (exact) return exact;
  const head = LONGEST_FIRST.find((w) => w.length >= 3 && word.endsWith(w));
  return head ? BY_WORD.get(head) : undefined;
}

export function storeSectionOf(name: string): StoreSection {
  const words = normaliseName(name).split(/[^\p{L}]+/u).filter(Boolean);
  for (const word of words) {
    const forced = OVERRIDES[word];
    if (forced) return forced;
  }
  // The last word is the head ("riven ost", "gul lök"); earlier words only when it says nothing.
  for (const word of words.toReversed()) {
    const section = sectionOfWord(word);
    if (section) return section;
  }
  return "other";
}
