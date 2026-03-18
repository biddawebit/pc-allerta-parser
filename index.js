import express from "express";
import fetch from "node-fetch";
import pdf from "pdf-parse";
import { XMLBuilder } from "fast-xml-parser";
import cors from "cors";
import { createCanvas } from "canvas";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

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

// Renderizza pagina PDF in canvas
async function renderPageToCanvas(pdfBuffer, pageNumber = 1) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
  const pdfDoc = await loadingTask.promise;
  const page = await pdfDoc.getPage(pageNumber);

  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext("2d");

  await page.render({ canvasContext: context, viewport }).promise;
  return { canvas, context, viewport };
}

// Legge colore pixel
function getPixelColor(context, x, y) {
  const data = context.getImageData(x, y, 1, 1).data;
  const [r, g, b, a] = data;
  return { r, g, b, a };
}

// Mappa RGB → livello
function rgbToLevel({ r, g, b }) {
  // TODO: tarare su PDF reali
  if (r > 240 && g > 240 && b > 240) return null; // bianco
  // giallo
  if (r > 230 && g > 230 && b < 150) return "GIALLO";
  // arancione
  if (r > 230 && g < 200 && b < 120) return "ARANCIONE";
  // rosso (se mai usato)
  if (r > 200 && g < 100 && b < 100) return "ROSSO";
  return null;
}

function livelloEmoji(livello) {
  if (livello === "GIALLO") return "🟡";
  if (livello === "ARANCIONE") return "🟠";
  if (livello === "ROSSO") return "🔴";
  return "⚪";
}

// Configurazione zone / rischi / colonne (da tarare)
const ZONES = [
  { nome: "Iglesiente", code: "SARD-A", yBase: 520 },
  { nome: "Campidano", code: "SARD-B", yBase: 600 },
  { nome: "Montevecchio Pischinappiu", code: "SARD-C", yBase: 680 },
  { nome: "Flumendosa Flumineddu", code: "SARD-D", yBase: 760 },
  { nome: "Tirso", code: "SARD-E", yBase: 840 },
  { nome: "Gallura", code: "SARD-F", yBase: 920 },
  { nome: "Logudoro", code: "SARD-G", yBase: 1000 }
];

const RISKS = [
  { tipo: "Idrogeologico", yOffset: 0 },
  { tipo: "Idraulico", yOffset: 20 },
  { tipo: "Temporali", yOffset: 40 },
  { tipo: "Neve", yOffset: 60 }
];

// Colonne orarie (x da tarare)
const COLS = [
  // Gio 05.03.2026
  { label: "Gio, 05.03.2026 dalle ore 14.00 alle ore 18.00", x: 700 },
  { label: "Gio, 05.03.2026 dalle ore 18.00 alle ore 21.00", x: 760 },
  // Ven 06.03.2026
  { label: "Ven, 06.03.2026 dalle ore 00.00 alle ore 03.00", x: 820 },
  { label: "Ven, 06.03.2026 dalle ore 03.00 alle ore 06.00", x: 880 },
  { label: "Ven, 06.03.2026 dalle ore 06.00 alle ore 09.00", x: 940 },
  { label: "Ven, 06.03.2026 dalle ore 09.00 alle ore 12.00", x: 1000 },
  { label: "Ven, 06.03.2026 dalle ore 12.00 alle ore 15.00", x: 1060 },
  { label: "Ven, 06.03.2026 dalle ore 15.00 alle ore 18.00", x: 1120 },
  { label: "Ven, 06.03.2026 dalle ore 18.00 alle ore 21.00", x: 1180 },
  // Sab 07.03.2026 Tendenza
  { label: "Sab, 07.03.2026 (Tendenza)", x: 1240 }
];

// Estrae livelli per zona/rischio/fascia
async function extractZoneLevelsFromPdf(pdfBuffer) {
  const { context } = await renderPageToCanvas(pdfBuffer, 1); // pagina con tabella

  const zoneData = [];

  for (const z of ZONES) {
    const rischiOut = [];

    for (const r of RISKS) {
      const fasce = [];

      for (const c of COLS) {
        const x = c.x;
        const y = z.yBase + r.yOffset; // TODO: tarare yBase/yOffset

        const color = getPixelColor(context, x, y);
        const livello = rgbToLevel(color);
        if (livello) {
          fasce.push({
            label: c.label,
            livello
          });
        }
      }

      if (fasce.length > 0) {
        // livello massimo tra le fasce
        const maxLevel = fasce.some(f => f.livello === "ROSSO")
          ? "ROSSO"
          : fasce.some(f => f.livello === "ARANCIONE")
          ? "ARANCIONE"
          : "GIALLO";

        const livello_label =
          maxLevel === "ROSSO"
            ? "Rosso (Elevata criticità)"
            : maxLevel === "ARANCIONE"
            ? "Arancione (Moderata criticità)"
            : "Giallo (Ordinaria criticità)";

        rischiOut.push({
          tipo: r.tipo,
          livello: maxLevel,
          livello_label,
          fasce: fasce.map(f => f.label)
        });
      }
    }

    if (rischiOut.length > 0) {
      zoneData.push({
        zona: z.nome,
        rischi: rischiOut
      });
    }
  }

  return zoneData;
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
    const zoneData = await extractZoneLevelsFromPdf(pdfBuffer);

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
