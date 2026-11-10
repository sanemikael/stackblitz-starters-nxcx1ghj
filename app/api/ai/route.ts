
import { NextResponse } from "next/server";

const MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
];

const CHUNK_SIZE = 12000;
const OVERLAP = 500;
const MAX_RETRIES = 2;

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

// Memecah dokumen dengan mempertahankan batas paragraf.
function splitDocument(text: string): string[] {
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_SIZE) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      let start = 0;

      while (start < paragraph.length) {
        const end = Math.min(
          start + CHUNK_SIZE,
          paragraph.length
        );

        chunks.push(paragraph.slice(start, end));

        if (end === paragraph.length) break;

        start = end - OVERLAP;
      }

      continue;
    }

    if (
      current.length + paragraph.length + 2 >
      CHUNK_SIZE
    ) {
      chunks.push(current);
      current = paragraph;
    } else {
      current += (current ? "\n\n" : "") + paragraph;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

// Memanggil Gemini dengan retry dan model cadangan.
async function askGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "API key Gemini belum dipasang di .env.local."
    );
  }

  let lastError = "";

  for (const model of MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [{ text: prompt }]
              }],
              generationConfig: {
                temperature: 0.3,
                responseMimeType: "application/json",
                maxOutputTokens: 5000
              }
            }),
            signal: AbortSignal.timeout(120000)
          }
        );

        const result = await response.json();

        if (response.ok) {
          const output = result.candidates?.[0]?.content
            ?.parts?.map((part: any) => part.text || "")
            .join("");

          if (!output) {
            throw new Error("AI tidak menghasilkan jawaban.");
          }

          return output
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();
        }

        const status = response.status;
        lastError =
          result.error?.message || `HTTP ${status}`;

        if ([400, 401, 403, 404].includes(status)) {
          throw new Error(lastError);
        }

        if (status === 429) {
          throw new Error(
            "Kuota Gemini tercapai. Periksa batas penggunaan API."
          );
        }

        if ([500, 503, 504].includes(status)) {
          await sleep(2000 * (attempt + 1));
          continue;
        }

        throw new Error(lastError);

      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("API key") ||
           error.message.includes("Kuota") ||
           error.message.includes("HTTP"))
        ) {
          throw error;
        }

        lastError =
          error instanceof Error
            ? error.message
            : "Koneksi Gemini gagal.";

        if (attempt < MAX_RETRIES - 1) {
          await sleep(2000 * (attempt + 1));
        }
      }
    }
  }

  throw new Error(
    "Semua model AI gagal memproses permintaan. " +
    lastError
  );
}

// Membaca JSON dari respons AI.
function parseJSON(output: string): any {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      "Format jawaban AI tidak valid. Silakan coba lagi."
    );
  }
}

// Memahami setiap bagian dokumen.
async function understandChunks(
  chunks: string[],
  action: string
): Promise<string[]> {
  const results: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const prompt = `
Kamu adalah asisten akademik.

Analisis bagian ${i + 1} dari ${chunks.length}
dari sebuah dokumen pembelajaran.

Pahami:
- Konsep utama.
- Definisi dan istilah penting.
- Fakta dan data.
- Hubungan sebab-akibat.
- Penjelasan dan contoh.
- Kesimpulan bagian tersebut.

Jangan mengarang informasi.
Pertahankan angka, nama, dan istilah penting.
Tuliskan hasil analisis secara ringkas tetapi informatif.
Gunakan bahasa Indonesia.

Hasil ini akan digabungkan dengan bagian lain,
jadi jangan menganggap bagian ini sebagai keseluruhan dokumen.

BAGIAN DOKUMEN:
${chunks[i]}
`;

    const output = await askGemini(prompt);
    results.push(output);
  }

  return results;
}

// Menggabungkan hasil analisis secara bertingkat.
async function mergeKnowledge(
  knowledge: string[]
): Promise<string> {
  let current = knowledge;

  while (current.join("\n").length > 18000) {
    const next: string[] = [];

    for (let i = 0; i < current.length; i += 5) {
      const group = current.slice(i, i + 5);

      const prompt = `
Gabungkan hasil analisis beberapa bagian dokumen berikut.

Pertahankan:
- Semua konsep penting.
- Data dan angka penting.
- Definisi.
- Hubungan antar konsep.
- Penjelasan dan kesimpulan.

Hilangkan pengulangan, tetapi jangan membuang informasi
yang diperlukan untuk memahami dokumen.

Jangan menambahkan fakta baru.

HASIL ANALISIS:
${group.join("\n\n")}
`;

      next.push(await askGemini(prompt));
    }

    current = next;
  }

  return current.join("\n\n");
}

// Ringkasan akhir.
async function createSummary(knowledge: string[]) {
  const combined = await mergeKnowledge(knowledge);

  const prompt = `
Kamu adalah dosen dan ahli pendidikan.

Berdasarkan keseluruhan hasil analisis dokumen,
buat ringkasan pembelajaran yang sistematis.

Ringkasan harus:
1. Memuat gambaran umum.
2. Menjelaskan konsep utama.
3. Menjelaskan hubungan antar konsep.
4. Memuat istilah penting.
5. Memuat fakta dan data penting.
6. Menjelaskan kesimpulan.
7. Tidak mengarang informasi.

Gunakan JSON:
{
  "title": "Judul ringkasan",
  "overview": "Gambaran umum",
  "sections": [
    {
      "heading": "Subjudul",
      "content": "Penjelasan"
    }
  ],
  "keyPoints": [
    "Poin penting"
  ],
  "conclusion": "Kesimpulan"
}

HASIL ANALISIS SELURUH DOKUMEN:
${combined}
`;

  return parseJSON(await askGemini(prompt));
}

// Soal akhir berdasarkan keseluruhan dokumen.
async function createQuiz(
  knowledge: string[],
  count: number
) {
  const combined = await mergeKnowledge(knowledge);

  const prompt = `
Kamu adalah dosen yang menyusun soal ujian.

Berdasarkan keseluruhan isi dokumen, buat ${count} soal
pilihan ganda yang menguji pemahaman.

Prioritaskan:
- Pemahaman konsep.
- Penerapan konsep.
- Analisis hubungan antar konsep.
- Interpretasi data.
- Sebab dan akibat.

Ketentuan:
1. Empat pilihan untuk setiap soal.
2. Hanya satu jawaban benar.
3. Posisi jawaban benar harus bervariasi.
4. Semua soal harus berdasarkan dokumen.
5. Jangan membuat informasi baru.
6. Berikan penjelasan jawaban.

Gunakan JSON:
{
  "questions": [
    {
      "question": "Pertanyaan",
      "options": [
        "Pilihan A",
        "Pilihan B",
        "Pilihan C",
        "Pilihan D"
      ],
      "answer": 0,
      "explanation": "Penjelasan"
    }
  ]
}

answer:
0 = A
1 = B
2 = C
3 = D

HASIL ANALISIS SELURUH DOKUMEN:
${combined}
`;

  return parseJSON(await askGemini(prompt));
}

// API utama.
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const action = body.action;
    const text = body.text;

    const count = Math.min(
      Math.max(Number(body.count) || 10, 1),
      20
    );

    if (
      typeof text !== "string" ||
      !text.trim() ||
      !["summary", "quiz"].includes(action)
    ) {
      return NextResponse.json(
        { error: "Dokumen atau jenis permintaan tidak valid." },
        { status: 400 }
      );
    }

    const chunks = splitDocument(text);

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "Dokumen tidak memiliki teks." },
        { status: 400 }
      );
    }

    // Membaca seluruh bagian dokumen secara berurutan.
    const knowledge = await understandChunks(
      chunks,
      action
    );

    const data =
      action === "summary"
        ? await createSummary(knowledge)
        : await createQuiz(knowledge, count);

    return NextResponse.json({
      success: true,
      action,
      totalCharacters: text.length,
      totalChunks: chunks.length,
      data
    });

  } catch (error) {
    console.error("AI processing error:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Terjadi kesalahan saat memproses dokumen."
      },
      { status: 500 }
    );
  }
}
