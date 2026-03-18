import express from "express";
import fetch from "node-fetch";
import pdf from "pdf-parse";
import { XMLBuilder } from "fast-xml-parser";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// Scarica URL (RSS o PDF)
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Errore download: " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Estrazione dati dal testo
function parseText(text) {
  const clean = text.replace(/\s+/g, " ");

  const titleMatch = clean.match(/AVVISO DI CRITICIT[AÀ].*?REGIONALE/i);
  const inizioMatch = clean.match(/Inizio validit[aà].*?(\d{2}.\d{2}.\d{4} \d{2}:\d{2})/i);
  const fineMatch = clean.match(/Fine validit[aà].*?(\d{2}.\d{2}.\d{4} \d{2}:\d{2})/i);

  const zone = [...clean.matchAll(/Iglesiente|Campidano|Montevecchio|Flumendosa|Tirso|Gallura|Logudoro/gi)]
    .map(z => z[0]);

  return {
    title: titleMatch?.[0] ?? "",
    inizio: inizioMatch?.[1] ?? "",
    fine: fineMatch?.[1] ?? "",
    zone: [...new Set(zone)]
  };
}

// Estrae link PDF da RSS
async function extractPdfFromRss(rssUrl) {
  const xmlText = await (await fetch(rssUrl)).text();
  const match = xmlText.match(/<link>(.*?)<\/link>/i);
  return match ? match[1] : null;
}

// API principale
app.post("/extract", async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: "Missing URL" });

    // Se è RSS → estrai PDF
    if (url.endsWith(".xml")) {
      const pdfUrl = await extractPdfFromRss(url);
      if (!pdfUrl) throw new Error("Nessun PDF trovato nel feed RSS");
      url = pdfUrl;
    }

    // Scarica PDF
    const pdfBuffer = await download(url);

    // Estrai testo
    const pdfData = await pdf(pdfBuffer);
    const parsed = parseText(pdfData.text);

    // Genera XML
    const builder = new XMLBuilder({ ignoreAttributes: false, format: true });
    const xml = builder.build({
      allerta: {
        titolo: parsed.title,
        inizio_validita: parsed.inizio,
        fine_validita: parsed.fine,
        zone: { zona: parsed.zone }
      }
    });

    res.json({
      success: true,
      xml,
      parsed,
      pdf_url: url
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("API ready on port 3000"));