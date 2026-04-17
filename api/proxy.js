export default async function handler(req, res) {
  try {
    const url = 'https://script.google.com/macros/s/AKfycbwBM3U_ck0s1LLLBCrJ1x1Btim5owb67HI53fyIy3mhNpPTJvG3byrALjUPNOdWFQLEWg/exec?type=all&key=WiltekAPI2026';
    const r = await fetch(url, { redirect: 'follow' });
    const data = await r.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
