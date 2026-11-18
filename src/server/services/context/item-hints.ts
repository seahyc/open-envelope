/**
 * Advisory category hints for marketplace order items.
 *
 * A hint is only ever a suggestion surfaced to the categoriser (as prompt context)
 * and to the UI. It never writes transactions.category and never overrides a
 * user's choice. Swap the keyword placeholder for a model-backed hinter by
 * implementing ItemCategoryHinter and passing it to OrdersIngestService.
 */
export interface ItemCategoryHinter {
  /** Returns a short category hint for an item title, or null when unsure. */
  suggest(title: string): string | null;
}

const KEYWORD_HINTS: Array<{ hint: string; pattern: RegExp }> = [
  { hint: 'groceries', pattern: /\b(rice|noodles?|snacks?|coffee|tea|milk|cereal|sauce|oil|biscuits?|chocolate|drinks?|water|beverage|grocer(y|ies))\b/i },
  { hint: 'baby', pattern: /\b(diapers?|nappies|baby|infant|toddler|formula|wipes)\b/i },
  { hint: 'pets', pattern: /\b(cat|dog|pet|kitten|puppy|litter|kibble)\b/i },
  { hint: 'health', pattern: /\b(vitamins?|supplements?|medicine|mask|thermometer|bandage|first aid|probiotic|pharmacy)\b/i },
  { hint: 'personal_care', pattern: /\b(shampoo|conditioner|toothpaste|toothbrush|soap|lotion|deodorant|razor|skincare|sunscreen|cosmetics?)\b/i },
  { hint: 'electronics', pattern: /\b(usb|charger|cable|adapter|headphones?|earbuds?|keyboard|mouse|monitor|ssd|hdd|laptop|tablet|phone case|power bank|hdmi|router|bluetooth|battery|batteries)\b/i },
  { hint: 'household', pattern: /\b(detergent|tissue|toilet paper|kitchen|towels?|bedsheets?|pillow|storage box|hanger|mop|broom|trash bags?|cleaner|sponge|cookware|pan|pot|lamp|bulb)\b/i },
  { hint: 'clothing', pattern: /\b(shirt|t-shirt|tee|dress|pants|jeans|shorts|socks|underwear|jacket|shoes?|sneakers|sandals?|bra|hoodie)\b/i },
  { hint: 'books_stationery', pattern: /\b(book|notebook|pen|pencil|stationery|paper|planner|marker)\b/i },
  { hint: 'sports_outdoors', pattern: /\b(yoga|dumbbell|fitness|bicycle|bike|camping|tent|swim|goggles|racket)\b/i },
  { hint: 'toys_games', pattern: /\b(toy|lego|puzzle|board game|doll|plush)\b/i },
];

export class KeywordItemHinter implements ItemCategoryHinter {
  suggest(title: string): string | null {
    const text = title || '';
    for (const row of KEYWORD_HINTS) {
      if (row.pattern.test(text)) return row.hint;
    }
    return null;
  }
}

export const defaultItemHinter: ItemCategoryHinter = new KeywordItemHinter();
