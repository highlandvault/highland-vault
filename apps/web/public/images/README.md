# Homepage imagery

Drop the photographs here with exactly these names and the homepage renders
them instead of the drawn scenes. Nothing else has to change: every container
is already the right size and aspect ratio, and `Scene` swaps to an `<img>` the
moment the file exists.

| File                  | Where it appears            | Aspect | Suggested size |
| --------------------- | --------------------------- | ------ | -------------- |
| `hero.jpg`            | Hero background             | 16 / 7 | 2400 × 1050    |
| `cat-whisky.jpg`      | Category card — Whisky      | 9 / 10 | 640 × 710      |
| `cat-tech.jpg`        | Category card — Tech        | 9 / 10 | 640 × 710      |
| `cat-cars.jpg`        | Category card — Cars        | 9 / 10 | 640 × 710      |
| `cat-property.jpg`    | Category card — Property    | 9 / 10 | 640 × 710      |
| `cat-experiences.jpg` | Category card — Experiences | 9 / 10 | 640 × 710      |
| `draw-featured.jpg`   | Featured draw               | 4 / 5  | 800 × 1000     |
| `barrels.jpg`         | "Discover rare whiskies"    | 16 / 5 | 2000 × 620     |

## Why there are no files here yet

Two reasons, and neither is a shortcut.

**O14 is open.** The storage/CDN decision has not been made, so prize
photography is not assumed anywhere in this project. `PrizeArt` on the draw
pages exists for the same reason.

**The photographs have to be ours.** The homepage design shows Macallan
bottles, iPhones, sports cars, villas and yachts. Those are other people's
product photography and other people's trademarks; they cannot be downloaded
into this repository, and hotlinking them would be the same problem with an
extra outage in it. Licensed stock, a photoshoot, or the distillery's own press
assets under licence are all fine — they just have to be obtained rather than
taken.

Until then the drawn scenes stand in. They are not placeholders in the "grey
box" sense: each is a composed gradient and silhouette sized to the final slot,
so the layout you see is the layout you get.

## Formats

`.jpg` for photographs, `.webp` if you have it (change the extension in
`scene.tsx`'s `PHOTOS` map). Keep them under about 400 KB each; the hero is the
only one big enough to matter for the first paint.
