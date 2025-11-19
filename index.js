const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

const USER_DATA_DIR = '/tmp/chrome_data_v10'; 
const COOKIE_PATH = '/tmp/cookies.json';

// --- WEBSHARE PROXY BİLGİLERİ ---
const PROXY_IP = '64.137.96.74';   // İspanya Proxy
const PROXY_PORT = '6641';
const PROXY_USER = 'punmxuuv';
const PROXY_PASS = 'hqrh1cvutdb1';

let globalBrowser = null;

// İnsan Tıklaması (Cloudflare için)
async function humanClick(page, element) {
    try {
        const box = await element.boundingBox();
        if(!box) return;
        const x = box.x + (box.width / 2) + (Math.random() * 10 - 5);
        const y = box.y + (box.height / 2) + (Math.random() * 10 - 5);
        
        await page.mouse.move(x, y, { steps: 25 });
        await new Promise(r => setTimeout(r, 600 + Math.random() * 300));
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 150));
        await page.mouse.up();
    } catch(e) {}
}

async function solveCloudflare(page) {
    console.log("🔍 Cloudflare Taraması...");
    await new Promise(r => setTimeout(r, 4000));
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const checkbox = await frame.$('input[type="checkbox"]');
            if (checkbox) {
                console.log("✅ Checkbox bulundu, tıklanıyor...");
                await humanClick(page, checkbox);
                return true;
            }
            const body = await frame.$('body');
            const text = await frame.evaluate(el => el.innerText, body);
            if (text.includes('Verify you are human')) {
                console.log("✅ Verify yazısı bulundu, tıklanıyor...");
                await humanClick(page, body);
                return true;
            }
        } catch (e) {}
    }
    return false;
}

async function startBrowser() {
    console.log('>>> Tarayıcı (Residential Proxy) başlatılıyor...');
    return await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            // Proxy Tüneli
            `--proxy-server=${PROXY_IP}:${PROXY_PORT}`
        ],
        executablePath: '/usr/bin/google-chrome'
    });
}

// --- LOGIN ---
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();

        // Proxy Kimlik Doğrulama
        console.log('Proxy girişi yapılıyor...');
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        // Proxy bazen yavaş olabilir, süreyi uzun tutalım
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 90000 });

        // Cloudflare Kontrolü
        for(let i=0; i<3; i++) {
            const title = await page.title();
            if(title.includes("Just a moment") || title.includes("Security")) {
                console.log(`⚠️ Cloudflare (Deneme ${i+1})`);
                await solveCloudflare(page);
                await new Promise(r => setTimeout(r, 6000)); 
            } else break;
        }

        const finalTitle = await page.title();
        if(finalTitle.includes("Just a moment")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ status: "error", message: "Proxy'ye rağmen CF geçilemedi. Başka bir IP deneyin.", debug_image: `<img src="data:image/png;base64,${shot}" />` });
        }

        console.log('Form bekleniyor...');
        await page.waitForSelector('#username', { visible: true, timeout: 30000 });

        console.log('Bilgiler giriliyor...');
        await page.type('#username', username, { delay: 150 });
        await page.type('#password', password, { delay: 150 });
        
        await Promise.all([
            page.click('#userLoginSubmitButton'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        ]);

        const content = await page.content();
        if (content.includes("Doğrulama Kodu") || content.includes("verification code")) {
             // SMS gelirse ekranı çekip gönderelim
            const shot = await page.screenshot({ encoding: 'base64' });
            return res.json({ 
                status: "sms_required", 
                message: "SMS kodu gerekli. /submit-sms kullanın.",
                debug_image: `<img src="data:image/png;base64,${shot}" />`
            });
        }

        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        await globalBrowser.close();
        res.json({ status: "success", message: "Giriş Başarılı!" });

    } catch (error) {
        console.error(error);
        let img = "";
        try { if(globalBrowser) img = await globalBrowser.pages()[0].screenshot({ encoding: 'base64' }); } catch(e){}
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
    }
});

// --- DİĞER FONKSİYONLAR (SMS, MESAJ OKUMA, CEVAPLAMA) ---
// Bu fonksiyonlar V6.2 ile aynı, buraya kopyalamayı unutma.
// Veya önceki kodun tamamını kullanıp sadece startBrowser ve login kısımlarını değiştirebilirsin.

app.listen(3000, () => console.log('Proxy V10 (Webshare) Hazır.'));
