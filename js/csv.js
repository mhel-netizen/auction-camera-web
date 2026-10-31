// AuctionFlex 360 lot-import CSV: Lot, Title, Description, Reserve, Start Bid.
const q = s => '"' + String(s || "").replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ").trim().replace(/"/g, '""') + '"';
const money = s => String(s || "").replace(/[^0-9.]/g, "");

export function buildCsv(lots) {
  const rows = ["Lot,Title,Description,Reserve,Start Bid"];
  lots.slice().sort((a, b) => a.number - b.number)
    .filter(l => (l.photos || []).length || (l.title || "").trim())
    .forEach(l => rows.push([l.number, q(l.title), q(l.description), q(money(l.reserve)), q(money(l.startBid))].join(",")));
  return rows.join("\r\n") + "\r\n";
}

export const csvName = a => (a.name || "Auction").replace(/[\\/:*?"<>|]/g, "-").trim() + " - lots.csv";
