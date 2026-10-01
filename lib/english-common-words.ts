/**
 * A curated common-English vocabulary, used for exactly one decision: whether a candidate span in
 * the typo-tolerant place fallback is ordinary language rather than a misspelled place name.
 *
 * WHAT THIS LIST IS. Ordinary English words — articles, pronouns, auxiliaries and modals, common
 * verbs, prepositions and conjunctions, quantifiers and determiners, frequent adjectives and
 * adverbs, question words, and the plain nouns that appear in scope phrases ("all cities", "every
 * state"). Entries are here BECAUSE THEY ARE ORDINARY ENGLISH, never because some town's name
 * happened to collide with one. It is not a place-exclusion list and no place name belongs in it.
 *
 * It is a curated vocabulary, NOT an empirically ranked frequency list — no corpus ranking was used,
 * and it should not be described as one. The entries are frozen here in source: no runtime download,
 * no new dependency, no generated data.
 *
 * WHAT IT CANNOT DO. A few hundred words cannot cover every ordinary word, every language, or every
 * future catalog collision. It bounds a demonstrated class of false place corrections; it does not
 * solve place understanding. Growing it is a judgement call about language, not a bug fix, and
 * adding a word only ever withholds a weak spelling correction — it never removes a real place,
 * because exact place matching runs first and is untouched by this list.
 *
 * Consumer: `fuzzyFallbackMention` in lib/geo-place-resolver.ts. Nothing else should read it without
 * a reason recorded at the call site.
 */

const WORDS = [
  // articles, determiners, quantifiers
  "a", "an", "the", "this", "that", "these", "those", "each", "every", "either", "neither",
  "all", "any", "some", "no", "none", "both", "few", "several", "many", "much", "more", "most",
  "less", "least", "other", "another", "same", "such", "own", "enough", "half", "whole", "entire",
  "certain", "various",
  // cardinals and number words
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "twenty", "thirty", "fifty", "hundred", "thousand", "million", "billion",
  "dozen", "once", "twice",
  // pronouns
  "i", "me", "my", "mine", "myself", "we", "us", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "it", "its", "they", "them", "their", "theirs",
  "who", "whom", "whose", "which", "what", "whatever", "whoever", "anyone", "everyone", "someone",
  "anything", "everything", "something", "nothing",
  // be, have, do, and modals
  "be", "am", "is", "are", "was", "were", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "done",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must", "ought", "let",
  // common verbs
  "get", "got", "give", "given", "gave", "go", "goes", "went", "gone", "going",
  "make", "makes", "made", "take", "takes", "took", "taken", "see", "sees", "saw", "seen",
  "come", "comes", "came", "know", "knows", "knew", "known", "think", "thought",
  "want", "wanted", "need", "needed", "use", "used", "using", "look", "looked",
  "find", "found", "show", "shows", "showed", "shown", "tell", "told", "say", "says", "said",
  "work", "works", "worked", "help", "keep", "kept", "put", "seem", "seems", "become", "became",
  "leave", "left", "feel", "felt", "try", "tried", "call", "called", "ask", "asked", "turn",
  "start", "started", "begin", "began", "run", "ran", "move", "moved", "live", "lived", "hold",
  "bring", "brought", "happen", "happened", "provide", "include", "included", "including",
  "compare", "compared", "list", "listed", "display", "please", "thanks",
  // prepositions, conjunctions, connectives
  "of", "in", "on", "at", "to", "for", "with", "without", "within", "from", "by", "about",
  "into", "onto", "over", "under", "above", "below", "between", "among", "through", "throughout",
  "across", "along", "around", "behind", "beyond", "beside", "besides", "against", "toward",
  "towards", "near", "nearby", "up", "down", "off", "out", "upon", "per", "via", "versus",
  "before", "after", "during", "since", "until", "till", "while", "when", "where", "why", "how",
  "and", "or", "but", "nor", "so", "if", "than", "then", "because", "though", "although",
  "unless", "whether", "as", "not", "also", "too", "only", "just", "even", "yet", "still",
  "back", "again", "ago", "instead", "however", "therefore", "thus", "hence",
  "like", "likely", "unlike", "alike", "regarding", "concerning", "despite", "except",
  // frequent adjectives and adverbs
  "good", "better", "best", "bad", "worse", "worst", "big", "bigger", "biggest",
  "small", "smaller", "smallest", "large", "larger", "largest", "little", "long", "longer",
  "longest", "short", "shorter", "high", "higher", "highest", "low", "lower", "lowest",
  "great", "greater", "greatest", "old", "older", "oldest", "new", "newer", "newest",
  "young", "younger", "early", "earlier", "earliest", "late", "later", "latest", "last", "first",
  "second", "third", "next", "previous", "prior", "recent", "current", "past", "future",
  "same", "different", "similar", "common", "rare", "full", "empty", "real", "true", "false",
  "left", "right", "top", "bottom", "overall", "total", "average", "median", "typical",
  "very", "really", "quite", "rather", "almost", "nearly", "about", "roughly", "approximately",
  "always", "never", "often", "sometimes", "usually", "rarely", "already", "soon", "now", "today",
  "yesterday", "tomorrow", "here", "there", "everywhere", "anywhere", "somewhere", "nowhere",
  "well", "far", "further", "furthest", "much", "many", "more", "most", "least", "only",
  // plain nouns that appear in scope phrases, not place names
  "city", "cities", "state", "states", "county", "counties", "country", "countries",
  "town", "towns", "place", "places", "area", "areas", "region", "regions", "agency", "agencies",
  "year", "years", "month", "months", "week", "weeks", "day", "days", "time", "times",
  "number", "numbers", "rate", "rates", "share", "shares", "count", "counts", "data", "people",
  "person", "way", "ways", "thing", "things", "part", "parts", "kind", "kinds", "type", "types",
  "case", "cases", "point", "points", "level", "levels", "group", "groups", "list", "lists",
] as const;

/** Normalized once at module load, matching the resolver's token-key normalization. */
const COMMON_ENGLISH_WORDS: ReadonlySet<string> = new Set(
  WORDS.map((word) => word.replace(/[^a-z0-9]+/gi, " ").toLowerCase().trim()).filter(Boolean)
);

/** Entry count, exposed so a test can pin the list's size against silent growth. */
export const COMMON_ENGLISH_WORD_COUNT = COMMON_ENGLISH_WORDS.size;

/**
 * Is `token` an ordinary English word? Takes a single token; a multi-word string will not match,
 * and an empty string never matches.
 */
export function isCommonEnglishWord(token: string): boolean {
  if (!token) return false;
  return COMMON_ENGLISH_WORDS.has(token.replace(/[^a-z0-9]+/gi, " ").toLowerCase().trim());
}
