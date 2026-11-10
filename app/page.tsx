
"use client";

import { useEffect, useState } from "react";

type Material = {
  id: number;
  name: string;
  text: string;
  size: string;
  date: string;
};

type Question = {
  question: string;
  options: string[];
  answer: number;
  explanation: string;
};

declare global {
  interface Window {
    pdfjsLib?: any;
  }
}

const DB = "AIStudyCompanionDB";
const STORE = "materials";
const PDF_VERSION = "3.11.174";
const PDF_CDN =
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_VERSION}`;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, {
          keyPath: "id"
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveMaterial(material: Material) {
  const db = await openDB();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(material);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };

    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function getMaterials(): Promise<Material[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function removeMaterial(id: number) {
  const db = await openDB();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };

    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function loadPDF(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (
      window.pdfjsLib?.version === PDF_VERSION
    ) {
      resolve(window.pdfjsLib);
      return;
    }

    if (window.pdfjsLib) {
      delete window.pdfjsLib;
    }

    document.getElementById("pdfjs-library")?.remove();

    const script = document.createElement("script");
    script.id = "pdfjs-library";
    script.src = `${PDF_CDN}/pdf.min.js`;

    script.onload = () => {
      const pdf = window.pdfjsLib;

      if (!pdf || pdf.version !== PDF_VERSION) {
        reject(new Error("Versi PDF.js tidak cocok."));
        return;
      }

      pdf.GlobalWorkerOptions.workerSrc =
        `${PDF_CDN}/pdf.worker.min.js`;

      resolve(pdf);
    };

    script.onerror = () => {
      reject(new Error("Gagal memuat PDF.js."));
    };

    document.head.appendChild(script);
  });
}

async function extractPDF(
  file: File,
  progress: (value: number) => void
) {
  const pdfjs = await loadPDF();
  const buffer = await file.arrayBuffer();

  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer)
  });

  const pdf = await task.promise;
  let result = "";

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      result += content.items
        .map((item: any) => item.str || "")
        .join(" ") + "\n\n";

      progress(Math.round(i / pdf.numPages * 100));

      page.cleanup();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    await task.destroy();
  }

  return result;
}

async function askAI(
  action: "summary" | "quiz",
  text: string,
  count = 10
) {
  const response = await fetch("/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action,
      text,
      count
    })
  });

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(
      result.error || "AI gagal memproses dokumen."
    );
  }

  return result.data;
}

export default function Home() {
  const [page, setPage] = useState("Dashboard");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [summary, setSummary] = useState<any>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<number[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  const selected = materials.find(m => m.id === selectedId);

  const menu = [
    { name: "Dashboard", icon: "⌂" },
    { name: "Materials", icon: "📚" },
    { name: "Upload", icon: "＋" },
    { name: "Summary", icon: "📝" },
    { name: "Quiz", icon: "✏️" }
  ];

  useEffect(() => {
    let active = true;

    getMaterials()
      .then(data => {
        if (active) {
          setMaterials(data);
          setReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setMessage("Penyimpanan browser tidak tersedia.");
          setReady(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function uploadFile(file?: File) {
    if (!file || loading) return;

    const name = file.name.toLowerCase();
    const isPDF = name.endsWith(".pdf");
    const isTXT = name.endsWith(".txt");

    if (!isPDF && !isTXT) {
      setMessage("Gunakan file PDF atau TXT.");
      return;
    }

    setLoading(true);
    setMessage("Membaca dokumen...");
    setProgress(0);

    try {
      const text = isTXT
        ? await file.text()
        : await extractPDF(file, setProgress);

      if (!text.trim()) {
        throw new Error(
          "Dokumen tidak memiliki teks yang bisa dibaca. PDF hasil scan memerlukan OCR."
        );
      }

      const material: Material = {
        id: Date.now(),
        name: file.name,
        text,
        size: (file.size / 1024 / 1024).toFixed(2) + " MB",
        date: new Date().toLocaleDateString("id-ID")
      };

      setMaterials(old => [...old, material]);
      setSelectedId(material.id);

      try {
        await saveMaterial(material);
        setMessage("Dokumen berhasil dibaca dan disimpan.");
      } catch {
        setMessage(
          "Dokumen dibaca, tetapi gagal disimpan di browser."
        );
      }

      setSummary(null);
      setQuestions([]);
      setPage("Materials");

    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Gagal membaca dokumen."
      );
    } finally {
      setLoading(false);
      setProgress(0);
    }
  }

  async function generateSummary(material = selected) {
    if (!material) {
      setMessage("Pilih materi terlebih dahulu.");
      setPage("Materials");
      return;
    }

    setSelectedId(material.id);
    setLoading(true);
    setMessage("Gemini sedang memahami dokumen dan menyusun ringkasan...");

    try {
      const result = await askAI("summary", material.text);

      setSummary(result);
      setPage("Summary");
      setMessage("Ringkasan AI berhasil dibuat!");

    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Gagal membuat ringkasan."
      );
    } finally {
      setLoading(false);
    }
  }

  async function generateQuiz(material = selected) {
    if (!material) {
      setMessage("Pilih materi terlebih dahulu.");
      setPage("Materials");
      return;
    }

    setSelectedId(material.id);
    setLoading(true);
    setMessage("Gemini sedang memahami dokumen dan membuat soal...");

    try {
      const result = await askAI("quiz", material.text, 10);

      if (
        !Array.isArray(result.questions) ||
        result.questions.length === 0
      ) {
        throw new Error("AI tidak menghasilkan soal yang valid.");
      }

      setQuestions(result.questions);
      setAnswers([]);
      setSubmitted(false);
      setPage("Quiz");
      setMessage("Soal latihan AI berhasil dibuat!");

    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Gagal membuat quiz."
      );
    } finally {
      setLoading(false);
    }
  }

  async function deleteMaterial(id: number) {
    try {
      await removeMaterial(id);
      setMaterials(old => old.filter(m => m.id !== id));

      if (selectedId === id) {
        setSelectedId(null);
        setSummary(null);
        setQuestions([]);
      }

      setMessage("Materi berhasil dihapus.");
    } catch {
      setMessage("Gagal menghapus materi.");
    }
  }

  const score = questions.reduce(
    (total, question, i) =>
      total + (answers[i] === question.answer ? 1 : 0),
    0
  );

  return (
    <main className="min-h-screen bg-[#111827] pb-24 text-gray-100 md:pb-6">
      <div className="flex min-h-screen">

        <aside className="hidden w-64 shrink-0 border-r border-gray-700 bg-gray-800 p-5 md:block">
          <h1 className="mb-10 text-xl font-bold text-indigo-400">
            ✦ AI Study Companion
          </h1>

          {menu.map(item => (
            <button
              key={item.name}
              onClick={() => setPage(item.name)}
              className={`mb-2 w-full rounded-xl p-3 text-left ${
                page === item.name
                  ? "bg-indigo-600"
                  : "text-gray-300 hover:bg-gray-700"
              }`}
            >
              {item.icon} <span className="ml-2">{item.name}</span>
            </button>
          ))}
        </aside>

        <section className="min-w-0 flex-1 p-5 md:p-8">
          <header className="mb-7 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400">
                YOUR PERSONAL LEARNING SPACE
              </p>
              <h2 className="mt-1 text-2xl font-bold">{page}</h2>
            </div>
            <span className="rounded-full bg-indigo-600 px-4 py-2 text-xs">
              ✦ Gemini AI
            </span>
          </header>

          {message && (
            <div className="mb-5 break-words rounded-xl border border-indigo-500 bg-indigo-500/10 p-3 text-sm text-indigo-200">
              {loading ? "⏳ " : "ℹ️ "}
              {message}

              <button
                className="float-right"
                onClick={() => setMessage("")}
              >
                ✕
              </button>

              {loading && progress > 0 && (
                <div className="mt-3 h-2 rounded-full bg-gray-700">
                  <div
                    className="h-2 rounded-full bg-indigo-400"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {!ready ? (
            <div className="rounded-xl bg-gray-800 p-5">
              Membuka penyimpanan...
            </div>
          ) : (
            <>
              {page === "Dashboard" && (
                <>
                  <div className="rounded-2xl bg-gradient-to-r from-indigo-700 to-purple-600 p-6">
                    <p>Welcome back!</p>
                    <h3 className="mt-2 text-2xl font-bold">
                      Learn smarter with AI.
                    </h3>
                    <p className="mt-3 text-sm text-indigo-100">
                      Upload materi dan biarkan Gemini membantu
                      memahami serta menguji pengetahuanmu.
                    </p>
                    <button
                      onClick={() => setPage("Upload")}
                      className="mt-5 rounded-xl bg-white px-5 py-3 font-semibold text-indigo-700"
                    >
                      + Upload Material
                    </button>
                  </div>

                  <div className="mt-7 grid gap-4 sm:grid-cols-3">
                    {[
                      ["📚", "Materials", materials.length],
                      ["📝", "Summary", summary ? 1 : 0],
                      ["✏️", "Quiz Questions", questions.length]
                    ].map(([icon, title, value]) => (
                      <div
                        key={String(title)}
                        className="rounded-2xl border border-gray-700 bg-gray-800 p-5"
                      >
                        <div className="text-2xl">{icon}</div>
                        <div className="mt-3 text-3xl font-bold">{value}</div>
                        <div className="text-sm text-gray-400">{title}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {page === "Upload" && (
                <div className="rounded-2xl border border-gray-700 bg-gray-800 p-6">
                  <h3 className="text-xl font-semibold">
                    Upload Learning Material
                  </h3>
                  <p className="mt-2 text-sm text-gray-400">
                    Pilih dokumen PDF atau TXT dari HP.
                  </p>
                  <p className="mt-2 text-xs text-yellow-300">
                    Tidak ada batas ukuran upload yang ditetapkan aplikasi,
                    tetapi RAM dan penyimpanan HP tetap membatasi.
                  </p>

                  <label className="mt-7 flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-indigo-500 p-8 text-center">
                    <span className="text-5xl">📄</span>
                    <span className="mt-4 font-semibold text-indigo-300">
                      Choose Document
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.txt,application/pdf,text/plain"
                      disabled={loading}
                      className="mt-5 max-w-full text-sm"
                      onChange={event => {
                        uploadFile(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
              )}

              {page === "Materials" && (
                <>
                  <h3 className="mb-4 font-semibold">My Materials</h3>

                  {materials.length === 0 && (
                    <p className="rounded-xl bg-gray-800 p-5 text-gray-400">
                      Belum ada dokumen.
                    </p>
                  )}

                  {materials.map(material => (
                    <div
                      key={material.id}
                      className="mb-3 rounded-xl border border-gray-700 bg-gray-800 p-4"
                    >
                      <p className="break-all font-medium">
                        📄 {material.name}
                      </p>
                      <p className="mt-1 text-xs text-gray-400">
                        {material.size} · {material.date}
                      </p>

                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          disabled={loading}
                          onClick={() => generateSummary(material)}
                          className="rounded-lg bg-indigo-600 px-3 py-2 text-sm disabled:opacity-40"
                        >
                          AI Summary
                        </button>

                        <button
                          disabled={loading}
                          onClick={() => generateQuiz(material)}
                          className="rounded-lg bg-gray-700 px-3 py-2 text-sm disabled:opacity-40"
                        >
                          AI Quiz
                        </button>

                        <button
                          onClick={() => deleteMaterial(material.id)}
                          className="rounded-lg bg-red-900 px-3 py-2 text-sm"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {page === "Summary" && (
                <div className="rounded-2xl border border-gray-700 bg-gray-800 p-5">
                  <h3 className="text-xl font-semibold">
                    AI Study Summary
                  </h3>

                  <select
                    className="mt-5 w-full rounded-xl bg-gray-700 p-3"
                    value={selectedId ?? ""}
                    onChange={event => {
                      setSelectedId(Number(event.target.value) || null);
                      setSummary(null);
                    }}
                  >
                    <option value="">Pilih materi</option>
                    {materials.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>

                  <button
                    disabled={loading}
                    onClick={() => generateSummary()}
                    className="mt-4 rounded-xl bg-indigo-600 px-5 py-3 disabled:opacity-40"
                  >
                    {loading ? "AI sedang bekerja..." : "Generate AI Summary"}
                  </button>

                  {summary && (
                    <div className="mt-6 space-y-5 rounded-xl bg-gray-700 p-5">
                      <div>
                        <h4 className="text-lg font-bold text-indigo-300">
                          {summary.title}
                        </h4>
                        <p className="mt-2 text-sm leading-7">
                          {summary.overview}
                        </p>
                      </div>

                      {summary.sections?.map((section: any, i: number) => (
                        <div key={i}>
                          <h5 className="font-semibold text-indigo-200">
                            {section.heading}
                          </h5>
                          <p className="mt-2 text-sm leading-7">
                            {section.content}
                          </p>
                        </div>
                      ))}

                      {summary.keyPoints && (
                        <div>
                          <h5 className="font-semibold text-indigo-200">
                            Poin Penting
                          </h5>
                          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
                            {summary.keyPoints.map((point: string, i: number) => (
                              <li key={i}>{point}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div>
                        <h5 className="font-semibold text-indigo-200">
                          Kesimpulan
                        </h5>
                        <p className="mt-2 text-sm leading-7">
                          {summary.conclusion}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {page === "Quiz" && (
                <div className="rounded-2xl border border-gray-700 bg-gray-800 p-5">
                  <h3 className="text-xl font-semibold">
                    AI Practice Quiz
                  </h3>

                  {questions.length === 0 ? (
                    <p className="mt-5 text-sm text-gray-400">
                      Pilih materi dan tekan AI Quiz.
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 text-sm text-gray-400">
                        {questions.length} pertanyaan dari Gemini
                      </p>

                      {questions.map((q, i) => (
                        <div
                          key={i}
                          className="mt-6 border-b border-gray-700 pb-5"
                        >
                          <p className="font-medium">
                            {i + 1}. {q.question}
                          </p>

                          <div className="mt-3 space-y-2">
                            {q.options.map((option, j) => (
                              <button
                                key={j}
                                disabled={submitted}
                                onClick={() => {
                                  const next = [...answers];
                                  next[i] = j;
                                  setAnswers(next);
                                }}
                                className={`block w-full rounded-lg p-3 text-left text-sm ${
                                  submitted
                                    ? j === q.answer
                                      ? "bg-green-800"
                                      : answers[i] === j
                                        ? "bg-red-900"
                                        : "bg-gray-700"
                                    : answers[i] === j
                                      ? "bg-indigo-600"
                                      : "bg-gray-700"
                                }`}
                              >
                                {String.fromCharCode(65 + j)}. {option}
                              </button>
                            ))}
                          </div>

                          {submitted && (
                            <p className="mt-3 text-xs leading-5 text-gray-300">
                              {q.explanation}
                            </p>
                          )}
                        </div>
                      ))}

                      {!submitted ? (
                        <button
                          disabled={
                            answers.filter(a => a !== undefined).length !==
                            questions.length
                          }
                          onClick={() => setSubmitted(true)}
                          className="mt-6 rounded-xl bg-green-600 px-5 py-3 disabled:opacity-40"
                        >
                          Submit Answers
                        </button>
                      ) : (
                        <div className="mt-6 rounded-xl bg-gray-700 p-5">
                          <h4 className="text-xl font-bold">Quiz Results</h4>
                          <p className="mt-3 text-3xl font-bold text-green-400">
                            {score} / {questions.length}
                          </p>
                          <p className="mt-2 text-sm text-gray-300">
                            Nilai: {Math.round(score / questions.length * 100)}%
                          </p>
                          <button
                            onClick={() => {
                              setAnswers([]);
                              setSubmitted(false);
                            }}
                            className="mt-5 rounded-lg bg-indigo-600 px-4 py-2"
                          >
                            Retry Quiz
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <footer className="mt-10 border-t border-gray-700 pt-5 text-center text-xs text-gray-500">
            AI Study Companion © 2026 · Powered by Gemini
          </footer>
        </section>
      </div>

      <nav className="fixed inset-x-0 bottom-0 flex justify-around border-t border-gray-700 bg-gray-800 p-3 md:hidden">
        {menu.map(item => (
          <button
            key={item.name}
            onClick={() => setPage(item.name)}
            className={`flex flex-col items-center gap-1 text-xs ${
              page === item.name
                ? "text-indigo-400"
                : "text-gray-400"
            }`}
          >
            <span className="text-lg">{item.icon}</span>
            <span>{item.name}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}
