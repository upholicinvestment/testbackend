import { Express, Request, Response } from "express";
import { Db } from "mongodb";
import crypto from "crypto";

type SecurityMeta = { name: string; sector: string };

type StockData = {
  _id: string;
  trading_symbol: string;
  LTP: string;
  close: string;
  sector: string;
  security_id: number;
  change?: number;
  received_at?: string;
};

function buildETag(identity: unknown) {
  return `"heatmap-${crypto
    .createHash("md5")
    .update(JSON.stringify(identity))
    .digest("hex")}"`;
}

const securities: { name: string; security_id: number; sector: string }[] = [
  { name: "360ONE NOV FUT", security_id: 38313, sector: "Financial Services" },
  { name: "ABB NOV FUT", security_id: 38314, sector: "Capital Goods" },
  { name: "ABCAPITAL NOV FUT", security_id: 38315, sector: "Financial Services" },
  { name: "ADANIENSOL NOV FUT", security_id: 38316, sector: "Utilities" },
  { name: "ADANIENT NOV FUT", security_id: 38317, sector: "Conglomerate" },
  { name: "ADANIGREEN NOV FUT", security_id: 39028, sector: "Utilities" },
  { name: "ADANIPORTS NOV FUT", security_id: 39029, sector: "Logistics" },
  { name: "ALKEM NOV FUT", security_id: 39030, sector: "Pharmaceuticals" },
  { name: "AMBER NOV FUT", security_id: 39031, sector: "Chemicals" },
  { name: "AMBUJACEM NOV FUT", security_id: 44170, sector: "Cement" },
  { name: "ANGELONE NOV FUT", security_id: 44171, sector: "Financial Services" },
  { name: "APLAPOLLO NOV FUT", security_id: 44172, sector: "Metals" },
  { name: "APOLLOHOSP NOV FUT", security_id: 44173, sector: "Healthcare" },
  { name: "ASHOKLEY NOV FUT", security_id: 44178, sector: "Automotive" },
  { name: "ASIANPAINT NOV FUT", security_id: 44179, sector: "Paints" },
  { name: "ASTRAL NOV FUT", security_id: 46470, sector: "Industrials" },
  { name: "AUBANK NOV FUT", security_id: 46472, sector: "Banking" },
  { name: "AUROPHARMA NOV FUT", security_id: 46473, sector: "Pharmaceuticals" },
  { name: "AXISBANK NOV FUT", security_id: 46477, sector: "Banking" },
  { name: "BAJAJ-AUTO NOV FUT", security_id: 48573, sector: "Automotive" },
  { name: "BAJAJFINSV NOV FUT", security_id: 48574, sector: "Financial Services" },
  { name: "BAJFINANCE NOV FUT", security_id: 48575, sector: "Financial Services" },
  { name: "BANDHANBNK NOV FUT", security_id: 48578, sector: "Banking" },
  { name: "BANKBARODA NOV FUT", security_id: 48579, sector: "Banking" },
  { name: "BANKINDIA NOV FUT", security_id: 48580, sector: "Banking" },
  { name: "BDL NOV FUT", security_id: 48581, sector: "Defence" },
  { name: "BEL NOV FUT", security_id: 48582, sector: "Defence" },
  { name: "BHARATFORG NOV FUT", security_id: 48586, sector: "Automotive" },
  { name: "BHARTIARTL NOV FUT", security_id: 48587, sector: "Telecom" },
  { name: "BHEL NOV FUT", security_id: 48588, sector: "Capital Goods" },
  { name: "BIOCON NOV FUT", security_id: 48594, sector: "Pharmaceuticals" },
  { name: "BLUESTARCO NOV FUT", security_id: 48595, sector: "Consumer Durables" },
  { name: "BOSCHLTD NOV FUT", security_id: 48596, sector: "Automotive" },
  { name: "BPCL NOV FUT", security_id: 48597, sector: "Oil & Gas" },
  { name: "BRITANNIA NOV FUT", security_id: 48598, sector: "FMCG" },
  { name: "BSE NOV FUT", security_id: 48599, sector: "Financial Services" },
  { name: "CAMS NOV FUT", security_id: 48600, sector: "Financial Services" },
  { name: "CANBK NOV FUT", security_id: 48602, sector: "Banking" },
  { name: "CDSL NOV FUT", security_id: 48603, sector: "Financial Services" },
  { name: "CGPOWER NOV FUT", security_id: 48605, sector: "Capital Goods" },
  { name: "CHOLAFIN NOV FUT", security_id: 48606, sector: "Financial Services" },
  { name: "CIPLA NOV FUT", security_id: 48607, sector: "Pharmaceuticals" },
  { name: "COALINDIA NOV FUT", security_id: 48608, sector: "Metals" },
  { name: "COFORGE NOV FUT", security_id: 48609, sector: "IT" },
  { name: "COLPAL NOV FUT", security_id: 48610, sector: "FMCG" },
  { name: "CONCOR NOV FUT", security_id: 48612, sector: "Logistics" },
  { name: "CROMPTON NOV FUT", security_id: 48613, sector: "Consumer Durables" },
  { name: "CUMMINSIND NOV FUT", security_id: 48614, sector: "Capital Goods" },
  { name: "CYIENT NOV FUT", security_id: 48618, sector: "IT" },
  { name: "DABUR NOV FUT", security_id: 48619, sector: "FMCG" },
  { name: "DALBHARAT NOV FUT", security_id: 48624, sector: "Cement" },
  { name: "DELHIVERY NOV FUT", security_id: 48625, sector: "Logistics" },
  { name: "DIVISLAB NOV FUT", security_id: 48626, sector: "Pharmaceuticals" },
  { name: "DIXON NOV FUT", security_id: 48627, sector: "Consumer Durables" },
  { name: "DLF NOV FUT", security_id: 48630, sector: "Real Estate" },
  { name: "DMART NOV FUT", security_id: 48631, sector: "Retail" },
  { name: "DRREDDY NOV FUT", security_id: 48632, sector: "Pharmaceuticals" },
  { name: "EICHERMOT NOV FUT", security_id: 48633, sector: "Automotive" },
  { name: "ETERNAL NOV FUT", security_id: 48634, sector: "Healthcare" },
  { name: "EXIDEIND NOV FUT", security_id: 48635, sector: "Automotive" },
  { name: "FEDERALBNK NOV FUT", security_id: 48636, sector: "Banking" },
  { name: "FORTIS NOV FUT", security_id: 48637, sector: "Healthcare" },
  { name: "GAIL NOV FUT", security_id: 48638, sector: "Oil & Gas" },
  { name: "GLENMARK NOV FUT", security_id: 48639, sector: "Pharmaceuticals" },
  { name: "GMRAIRPORT NOV FUT", security_id: 48640, sector: "Logistics" },
  { name: "GODREJCP NOV FUT", security_id: 48641, sector: "FMCG" },
  { name: "GODREJPROP NOV FUT", security_id: 48642, sector: "Real Estate" },
  { name: "GRASIM NOV FUT", security_id: 48643, sector: "Cement" },
  { name: "HAL NOV FUT", security_id: 48644, sector: "Defence" },
  { name: "HAVELLS NOV FUT", security_id: 48649, sector: "Consumer Durables" },
  { name: "HCLTECH NOV FUT", security_id: 48650, sector: "IT" },
  { name: "HDFCAMC NOV FUT", security_id: 48651, sector: "Financial Services" },
  { name: "HDFCBANK NOV FUT", security_id: 48652, sector: "Banking" },
  { name: "HDFCLIFE NOV FUT", security_id: 48657, sector: "Insurance" },
  { name: "HEROMOTOCO NOV FUT", security_id: 48658, sector: "Automotive" },
  { name: "HFCL NOV FUT", security_id: 48671, sector: "Telecom" },
  { name: "HINDALCO NOV FUT", security_id: 48672, sector: "Metals" },
  { name: "HINDPETRO NOV FUT", security_id: 48693, sector: "Oil & Gas" },
  { name: "HINDUNILVR NOV FUT", security_id: 48694, sector: "FMCG" },
  { name: "HINDZINC NOV FUT", security_id: 48699, sector: "Metals" },
  { name: "HUDCO NOV FUT", security_id: 48700, sector: "Financial Services" },
  { name: "ICICIBANK NOV FUT", security_id: 48707, sector: "Banking" },
  { name: "ICICIGI NOV FUT", security_id: 48708, sector: "Insurance" },
  { name: "ICICIPRULI NOV FUT", security_id: 48732, sector: "Insurance" },
  { name: "IDEA NOV FUT", security_id: 48733, sector: "Telecom" },
  { name: "IDFCFIRSTB NOV FUT", security_id: 48734, sector: "Banking" },
  { name: "IEX NOV FUT", security_id: 48735, sector: "Utilities" },
  { name: "IGL NOV FUT", security_id: 48742, sector: "Oil & Gas" },
  { name: "IIFL NOV FUT", security_id: 48743, sector: "Financial Services" },
  { name: "INDHOTEL NOV FUT", security_id: 48746, sector: "Hospitality" },
  { name: "INDIANB NOV FUT", security_id: 48747, sector: "Banking" },
  { name: "INDIGO NOV FUT", security_id: 48750, sector: "Aviation" },
  { name: "INDUSINDBK NOV FUT", security_id: 48751, sector: "Banking" },
  { name: "INDUSTOWER NOV FUT", security_id: 48782, sector: "Telecom" },
  { name: "INFY NOV FUT", security_id: 48783, sector: "IT" },
  { name: "INOXWIND NOV FUT", security_id: 48797, sector: "Capital Goods" },
  { name: "IOC NOV FUT", security_id: 48798, sector: "Oil & Gas" },
  { name: "IRCTC NOV FUT", security_id: 48799, sector: "Tourism" },
  { name: "IREDA NOV FUT", security_id: 48800, sector: "Financial Services" },
  { name: "IRFC NOV FUT", security_id: 48802, sector: "Financial Services" },
  { name: "ITC NOV FUT", security_id: 48803, sector: "FMCG" },
  { name: "JINDALSTEL NOV FUT", security_id: 48810, sector: "Metals" },
  { name: "JIOFIN NOV FUT", security_id: 48811, sector: "Financial Services" },
  { name: "JSWENERGY NOV FUT", security_id: 48816, sector: "Utilities" },
  { name: "JSWSTEEL NOV FUT", security_id: 48817, sector: "Metals" },
  { name: "JUBLFOOD NOV FUT", security_id: 48839, sector: "Quick Service Restaurant" },
  { name: "KALYANKJIL NOV FUT", security_id: 48840, sector: "Retail" },
  { name: "KAYNES NOV FUT", security_id: 48850, sector: "IT" },
  { name: "KEI NOV FUT", security_id: 48851, sector: "Capital Goods" },
  { name: "KFINTECH NOV FUT", security_id: 48857, sector: "Financial Services" },
  { name: "KOTAKBANK NOV FUT", security_id: 48858, sector: "Banking" },
  { name: "KPITTECH NOV FUT", security_id: 48859, sector: "IT" },
  { name: "LAURUSLABS NOV FUT", security_id: 48860, sector: "Pharmaceuticals" },
  { name: "LICHSGFIN NOV FUT", security_id: 48864, sector: "Financial Services" },
  { name: "LICI NOV FUT", security_id: 48865, sector: "Insurance" },
  { name: "LODHA NOV FUT", security_id: 48873, sector: "Real Estate" },
  { name: "LT NOV FUT", security_id: 48874, sector: "Infrastructure" },
  { name: "LTF NOV FUT", security_id: 48878, sector: "Financial Services" },
  { name: "LTIM NOV FUT", security_id: 48879, sector: "IT" },
  { name: "LUPIN NOV FUT", security_id: 48884, sector: "Pharmaceuticals" },
  { name: "M&M NOV FUT", security_id: 48887, sector: "Automotive" },
  { name: "MANAPPURAM NOV FUT", security_id: 48888, sector: "Financial Services" },
  { name: "MANKIND NOV FUT", security_id: 48889, sector: "Pharmaceuticals" },
  { name: "MARICO NOV FUT", security_id: 48891, sector: "FMCG" },
  { name: "MARUTI NOV FUT", security_id: 48892, sector: "Automotive" },
  { name: "MAXHEALTH NOV FUT", security_id: 48896, sector: "Healthcare" },
  { name: "MAZDOCK NOV FUT", security_id: 48897, sector: "Defence" },
  { name: "MCX NOV FUT", security_id: 48898, sector: "Financial Services" },
  { name: "MFSL NOV FUT", security_id: 48901, sector: "Insurance" },
  { name: "MOTHERSON NOV FUT", security_id: 48902, sector: "Automotive" },
  { name: "MPHASIS NOV FUT", security_id: 48904, sector: "IT" },
  { name: "MUTHOOTFIN NOV FUT", security_id: 48910, sector: "Financial Services" },
  { name: "NATIONALUM NOV FUT", security_id: 48911, sector: "Metals" },
  { name: "NAUKRI NOV FUT", security_id: 48916, sector: "IT" },
  { name: "NBCC NOV FUT", security_id: 48917, sector: "Construction" },
  { name: "NCC NOV FUT", security_id: 48920, sector: "Construction" },
  { name: "NESTLEIND NOV FUT", security_id: 48921, sector: "FMCG" },
  { name: "NHPC NOV FUT", security_id: 48931, sector: "Utilities" },
  { name: "NMDC NOV FUT", security_id: 48932, sector: "Metals" },
  { name: "NTPC NOV FUT", security_id: 48960, sector: "Utilities" },
  { name: "NUVAMA NOV FUT", security_id: 48961, sector: "Financial Services" },
  { name: "NYKAA NOV FUT", security_id: 48962, sector: "Retail" },
  { name: "OBEROIRLTY NOV FUT", security_id: 48963, sector: "Real Estate" },
  { name: "OFSS NOV FUT", security_id: 48995, sector: "IT" },
  { name: "OIL NOV FUT", security_id: 48996, sector: "Oil & Gas" },
  { name: "ONGC NOV FUT", security_id: 49054, sector: "Oil & Gas" },
  { name: "PAGEIND NOV FUT", security_id: 49055, sector: "Textiles" },
  { name: "PATANJALI NOV FUT", security_id: 49056, sector: "FMCG" },
  { name: "PAYTM NOV FUT", security_id: 49057, sector: "IT" },
  { name: "PERSISTENT NOV FUT", security_id: 49058, sector: "IT" },
  { name: "PETRONET NOV FUT", security_id: 49059, sector: "Oil & Gas" },
  { name: "PFC NOV FUT", security_id: 49060, sector: "Financial Services" },
  { name: "PGEL NOV FUT", security_id: 49061, sector: "Utilities" },
  { name: "PHOENIXLTD NOV FUT", security_id: 49062, sector: "Real Estate" },
  { name: "PIDILITIND NOV FUT", security_id: 49064, sector: "Chemicals" },
  { name: "PIIND NOV FUT", security_id: 49065, sector: "Chemicals" },
  { name: "PNB NOV FUT", security_id: 49067, sector: "Banking" },
  { name: "PNBHOUSING NOV FUT", security_id: 49068, sector: "Financial Services" },
  { name: "POLICYBZR NOV FUT", security_id: 49069, sector: "IT" },
  { name: "POLYCAB NOV FUT", security_id: 49071, sector: "Capital Goods" },
  { name: "POWERGRID NOV FUT", security_id: 49073, sector: "Utilities" },
  { name: "PPLPHARMA NOV FUT", security_id: 49074, sector: "Pharmaceuticals" },
  { name: "PRESTIGE NOV FUT", security_id: 49075, sector: "Real Estate" },
  { name: "RBLBANK NOV FUT", security_id: 49076, sector: "Banking" },
  { name: "RECLTD NOV FUT", security_id: 49077, sector: "Financial Services" },
  { name: "RELIANCE NOV FUT", security_id: 49078, sector: "Conglomerate" },
  { name: "RVNL NOV FUT", security_id: 49079, sector: "Infrastructure" },
  { name: "SAIL NOV FUT", security_id: 49080, sector: "Metals" },
  { name: "SAMMAANCAP NOV FUT", security_id: 49083, sector: "Financial Services" },
  { name: "SBICARD NOV FUT", security_id: 49084, sector: "Financial Services" },
  { name: "SBILIFE NOV FUT", security_id: 49085, sector: "Insurance" },
  { name: "SBIN NOV FUT", security_id: 49086, sector: "Banking" },
  { name: "SHREECEM NOV FUT", security_id: 49087, sector: "Cement" },
  { name: "SHRIRAMFIN NOV FUT", security_id: 49088, sector: "Financial Services" },
  { name: "SIEMENS NOV FUT", security_id: 49089, sector: "Capital Goods" },
  { name: "SOLARINDS NOV FUT", security_id: 49090, sector: "Chemicals" },
  { name: "SONACOMS NOV FUT", security_id: 49091, sector: "Automotive" },
  { name: "SRF NOV FUT", security_id: 49092, sector: "Chemicals" },
  { name: "SUNPHARMA NOV FUT", security_id: 49093, sector: "Pharmaceuticals" },
  { name: "SUPREMEIND NOV FUT", security_id: 49094, sector: "Consumer Durables" },
  { name: "SUZLON NOV FUT", security_id: 49095, sector: "Capital Goods" },
  { name: "SYNGENE NOV FUT", security_id: 49096, sector: "Pharmaceuticals" },
  { name: "TATACONSUM NOV FUT", security_id: 49097, sector: "FMCG" },
  { name: "TATAELXSI NOV FUT", security_id: 49108, sector: "IT" },
  { name: "TATAMOTORS NOV FUT", security_id: 49109, sector: "Automotive" },
  { name: "TATAPOWER NOV FUT", security_id: 49114, sector: "Utilities" },
  { name: "TATASTEEL NOV FUT", security_id: 49115, sector: "Metals" },
  { name: "TATATECH NOV FUT", security_id: 49118, sector: "IT" },
  { name: "TCS NOV FUT", security_id: 49119, sector: "IT" },
  { name: "TECHM NOV FUT", security_id: 49126, sector: "IT" },
  { name: "TIINDIA NOV FUT", security_id: 49127, sector: "Automotive" },
  { name: "TITAGARH NOV FUT", security_id: 49130, sector: "Capital Goods" },
  { name: "TITAN NOV FUT", security_id: 49131, sector: "Consumer Discretionary" },
  { name: "TORNTPHARM NOV FUT", security_id: 49132, sector: "Pharmaceuticals" },
  { name: "TORNTPOWER NOV FUT", security_id: 49133, sector: "Utilities" },
  { name: "TRENT NOV FUT", security_id: 49134, sector: "Retail" },
  { name: "TVSMOTOR NOV FUT", security_id: 49135, sector: "Automotive" },
  { name: "ULTRACEMCO NOV FUT", security_id: 49136, sector: "Cement" },
  { name: "UNIONBANK NOV FUT", security_id: 49137, sector: "Banking" },
  { name: "UNITDSPR NOV FUT", security_id: 49139, sector: "FMCG" },
  { name: "UNOMINDA NOV FUT", security_id: 49140, sector: "Automotive" },
  { name: "UPL NOV FUT", security_id: 49150, sector: "Chemicals" },
  { name: "VBL NOV FUT", security_id: 49151, sector: "FMCG" },
  { name: "VEDL NOV FUT", security_id: 49163, sector: "Metals" },
  { name: "VOLTAS NOV FUT", security_id: 49164, sector: "Consumer Durables" },
  { name: "WIPRO NOV FUT", security_id: 49170, sector: "IT" },
  { name: "YESBANK NOV FUT", security_id: 49171, sector: "Banking" },
  { name: "ZYDUSLIFE NOV FUT", security_id: 49201, sector: "Pharmaceuticals" },
  { name: "POWERINDIA NOV FUT", security_id: 49975, sector: "Capital Goods" },
];




export function Heatmap(app: Express, db: Db) {
  const collection = db.collection("nse_futstk_ohlc");

  // Indexes to make sort+group fast (doesn't alter logic)
  (async () => {
    try {
      await collection.createIndex({ security_id: 1, received_at: -1 });
      await collection.createIndex({ received_at: -1 });
    } catch (e) {
      console.warn("[heatmap] index creation warning:", (e as Error)?.message || e);
    }
  })();

  const securityIdMap = new Map<number, SecurityMeta>();
  const securityIds: number[] = [];
  securities.forEach((sec) => {
    securityIdMap.set(sec.security_id, { name: sec.name, sector: sec.sector });
    securityIds.push(sec.security_id);
  });

  /** Shared aggregation that returns the latest doc (within cutoff) per security_id */
  async function latestPerSecurity(sinceMin: number) {
    const cutoff = new Date(Date.now() - Math.max(1, sinceMin) * 60_000);

    const pipeline = [
      {
        $match: {
          security_id: { $in: securityIds },
          received_at: { $gte: cutoff },
        },
      },
      { $sort: { received_at: -1 } },
      { $group: { _id: "$security_id", latestDoc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$latestDoc" } },
      {
        $project: {
          _id: 1,
          security_id: 1,
          LTP: 1,
          close: 1,
          received_at: 1,
        },
      },
    ];

    const items = await collection.aggregate(pipeline, { allowDiskUse: true }).toArray();

    const processed: StockData[] = items.map((item: any) => {
      const securityId = Number(item.security_id);
      const meta = securityIdMap.get(securityId);

      const ltp = parseFloat(item.LTP ?? "0");
      const close = parseFloat(item.close ?? "0");
      const change =
        ltp && close && !Number.isNaN(ltp) && !Number.isNaN(close) && close !== 0
          ? ((ltp - close) / close) * 100
          : undefined;

      return {
        _id: item._id?.toString() ?? "",
        trading_symbol: meta?.name ?? "",
        LTP: item.LTP ?? "",
        close: item.close ?? "",
        sector: meta?.sector ?? "Unknown",
        security_id: securityId,
        change,
        received_at: item.received_at ? new Date(item.received_at).toISOString() : undefined,
      };
    });

    // identity for ETag: count + max timestamp + rough sums
    let lastISO: string | null = null;
    let sumL = 0;
    let sumC = 0;
    for (const it of processed) {
      const l = parseFloat(it.LTP ?? "0");
      const c = parseFloat(it.close ?? "0");
      if (Number.isFinite(l)) sumL += l;
      if (Number.isFinite(c)) sumC += c;
      const t = it.received_at ? new Date(it.received_at).getTime() : 0;
      if (!lastISO || (t && (!lastISO || t > new Date(lastISO).getTime()))) {
        lastISO = it.received_at!;
      }
    }

    return { processed, lastISO, sumL: Math.round(sumL), sumC: Math.round(sumC) };
  }

  /**
   * Legacy/simple endpoint: GET /api/heatmap
   * Returns array of stocks (latest per security). 60s cache headers.
   */
  app.get("/api/heatmap", async (_req: Request, res: Response) => {
    try {
      const { processed } = await latestPerSecurity(1440); // 24h cutoff by default
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
      res.setHeader("Vary", "Accept-Encoding");
      res.json(processed);
    } catch (error) {
      console.error("Error fetching heatmap data:", error);
      res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * Bulk + ETag + 24h backfill by default
   * GET /api/heatmap/bulk?sinceMin=1440
   * Response: { stocks: StockData[], lastISO: string|null }
   */
  app.get("/api/heatmap/bulk", async (req: Request, res: Response) => {
    try {
      const sinceMin = Math.max(1, Number(req.query.sinceMin) || 1440);
      const { processed, lastISO, sumL, sumC } = await latestPerSecurity(sinceMin);

      const identity = { cnt: processed.length, lastISO, sumL, sumC, sinceMin };
      const etag = buildETag(identity);

      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "no-store");
      res.json({ stocks: processed, lastISO });
    } catch (error) {
      console.error("Error in /api/heatmap/bulk:", error);
      res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}                                                      