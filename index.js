import express from "express";
import fetch from "node-fetch";
import pdf from "pdf-parse";
import { XMLBuilder } from "fast-xml-parser";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// Scarica PDF
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Errore download: " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Metadati generali
function parseMeta(text) {
  const clean = text.replace(/\s+/g, " ");

  const titleMatch = clean.match(/AVVISO DI CRITICIT[AÀ].*?(?=Zona|Validit[aà]|Data di emissione|Prot\.|IL DIRETTORE)/i);
  const inizioMatch = clean.match(/Inizio validit[aà].*?(\d{2}.\d{2}.\d{4} \d{2}:\d{2})/i);
  const fineMatch = clean.match(/Fine validit[aà].*?(\d{2}.\d{2}.\d{4} \d{2}:\d{2})/i);

  return {
    titolo: titleMatch?.[0]?.trim() || "AVVISO DI CRITICITÀ PER RISCHIO IDROGEOLOGICO E IDRAULICO",
    inizio_validita: inizioMatch?.[1] || "",
    fine_validita: fineMatch?.[1] || "",
    pubDate: new Date().toUTCString()
  };
}

// Mappa livello → emoji
function livelloEmoji(livello) {
  if (/GIALLO/i.test(livello)) return "🟡";
  if (/ARANCIONE/i.test(livello)) return "🟠";
  if (/ROSSO/i.test(livello)) return "🔴";
  return "⚪";
}

// Estrae blocchi per zona dal testo (best effort)
function extractZonesFromText(text) {
  const clean = text.replace(/\r/g, "");
  const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);

  const zoneNames = [
    "Iglesiente",
    "Campidano",
    "Montevecchio Pischinappiu",
    "Flumendosa Flumineddu",
    "Tirso",
    "Gallura",
    "Logudoro"
  ];

  const zones = [];

  zoneNames.forEach(zona => {
    // Trova righe che contengono il nome zona
    const zoneLines = lines.filter(l => l.toLowerCase().includes(zona.toLowerCase()));
    if (zoneLines.length === 0) return;

    // Per semplicità, prendiamo un intorno di righe
    const indices = lines
      .map((l, i) => ({ l, i }))
      .filter(o => o.l.toLowerCase().includes(zona.toLowerCase()))
      .map(o => o.i);

    const blocco = [];
    indices.forEach(idx => {
      for (let i = Math.max(0, idx - 10); i <= Math.min(lines.length - 1, idx + 20); i++) {
        blocco.push(lines[i]);
      }
    });

    const bloccoText = [...new Set(blocco)].join(" ");

    // Estrai rischi, livelli, fasce
    const rischi = [];

    // Pattern tipo: "Rischio: Idrogeologico" + "Livello: Giallo (Ordinaria criticità)" + fasce
    const rischioRegex = /Rischio[: ]+([A-Za-zàèéìòùÀÈÉÌÒÙ ]+).*?Livello[: ]+([A-Za-zàèéìòùÀÈÉÌÒÙ ()]+)(.*?)(?=Rischio[: ]+|$)/gi;
    let m;
    while ((m = rischioRegex.exec(bloccoText)) !== null) {
      const tipo = m[1].trim();
      const livello_label = m[2].trim();
      const resto = m[3] || "";

      const fasce = [];
      const fasciaRegex = /(?:Gio|Ven|Sab|Dom|Lun|Mar|Mer)[^,]*,\s*\d{2}.\d{2}.\d{4}[^0-9]*\d{2}.\d{2}[^0-9]*\d{2}.\d{2}/gi;
      let f;
      while ((f = fasciaRegex.exec(resto)) !== null) {
        fasce.push(f[0].replace(/\s+/g, " ").trim());
      }

      rischi.push({
        tipo,
        livello: livello_label.toUpperCase().includes("ARANCIONE")
          ? "ARANCIONE"
          : livello_label.toUpperCase().includes("ROSSO")
          ? "ROSSO"
          : "GIALLO",
        livello_label,
        fasce
      });
    }

    if (rischi.length > 0) {
      zones.push({ zona, rischi });
    }
  });

  return zones;
}

// Costruisce RSS
function buildRss(meta, zoneData) {
  const items = zoneData.map(z => {
    let desc = `${meta.titolo} Zona ${z.zona} Validità bollettino: dal ${meta.inizio_validita} al ${meta.fine_validita} `;

    z.rischi.forEach(r => {
      desc += `⚠️ Rischio: ${r.tipo} ${livelloEmoji(r.livello)} Livello: ${r.livello_label} Fasce orarie: `;
      if (r.fasce.length === 0) {
        desc += "- (non specificate) ";
      } else {
        r.fasce.forEach(f => {
          desc += `- 🗓️⏰ ${f} `;
        });
      }
    });

    return {
      title: { "#text": `Allerta Zona: ${z.zona}` },
      pubDate: meta.pubDate,
      category: { "#text": z.zona },
      description: { "#text": desc.trim() }
    };
  });

  const rssObj = {
    rss: {
      "@_version": "2.0",
      channel: {
        title: "Allerte Protezione Civile Sardegna",
        description: { "#text": meta.titolo },
        item: items
      }
    }
  };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true
  });

  return builder.build(rssObj);
}

// API principale
app.post("/extract", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Missing URL" });

    const pdfBuffer = await download(url);
    const pdfData = await pdf(pdfBuffer);

    const meta = parseMeta(pdfData.text);
    const zoneData = extractZonesFromText(pdfData.text);

    const rssXml = buildRss(meta, zoneData);

    res.json({
      success: true,
      rss: rssXml,
      meta,
      zoneData
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("API ready on port 3000"));
