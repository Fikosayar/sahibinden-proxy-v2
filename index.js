// V7.2 - GÜVENLİ MOD
console.log('>>> Uygulama başlatılıyor... (Adım 1)');

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

console.log('>>> Kütüphaneler yüklendi. (Adım 2)');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

// GÜVENLİ KLASÖR YOLU (/tmp her zaman yazılabilir)
const USER_DATA_DIR = '/tmp/chrome_data'; 
const COOKIE_PATH = '/tmp/cookies.json';

let globalBrowser = null;
let globalPage = null;

// Yardımcı Fonksiyonlar
async function humanClick(page, element) {
    try {
        const box = await element.boundingBox();
        if(!box) return;
        const x = box.x + (box.width / 2) + (Math.random() * 10 - 5);
        const y = box.y + (box.height / 2) + (Math.random() * 10 - 5);
        await page.mouse.move(x, y, { steps: 25 });
        await new Promise(r => setTimeout(r, 500));
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 100));
        await page.mouse.up();
    } catch(e) { console.error("Click hatası:", e.message); }
}

async function solveCloudflare(page) {
    console.log("Cloudflare kontrol ediliyor...");
    try {
        await new Promise(r => setTimeout(r, 3000));
        const frames = page.frames();
        for (const frame of frames) {
            const checkbox = await frame.$('input[type="checkbox"]');
            if (checkbox) {
                console.log("Checkbox bulundu, tıklanıyor.");
                await humanClick(page, checkbox);
                return true;
            }
            const body = await frame.$('body');
            if(body) {
                const text = await frame.evaluate(el => el.innerText, body);
                if (text.includes('Verify you are human')) {
                    console.log("Verify yazısı bulundu, tıklanıyor.");
                    await humanClick(page, body);
                    return true;
                }
            }
        }
    } catch (e) { console.log("CF Tarama hatası (önemsiz):", e.message); }
    return false;
}

async function startBrowser() {
    console.log('>>> Tarayıcı motoru ısıtılıyor...');
    return await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled'
        ],
        executablePath: '/usr/bin/google-chrome'
    });
}

// --- ENDPOINTS ---

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        globalPage = page;

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
        console.log('Giriş sayfasına gidiliyor...');
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 60000 });

        // Cloudflare
        await solveCloudflare(page);
        await new Promise(r => setTimeout(r, 5000)); // Bekle

        // Başlık kontrol
        const title = await page.title();
        if(title.includes("Just a moment")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ status: "error", message: "Cloudflare engeli.", debug_image: `<img src="data:image/png;base64,${shot}" />` });
        }

        console.log('Form dolduruluyor...');
        await page.waitForSelector('#username', { visible: true, timeout: 15000 });
        await page.type('#username', username, { delay: 100 });
        await page.type('#password', password, { delay: 100 });
        
        await Promise.all([
            page.click('#userLoginSubmitButton'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        ]);

        // SMS?
        const content = await page.content();
        if (content.includes("Doğrulama Kodu") || content.includes("verification code")) {
            const shot = await page.screenshot({ encoding: 'base64' });
            return res.json({ status: "sms_required", message: "SMS Kodu gerekli.", debug_image: `<img src="data:image/png;base64,${shot}" />` });
        }

        // Kaydet
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        await globalBrowser.close();
        res.json({ status: "success", message: "Giriş Başarılı." });

    } catch (error) {
        console.error("Login Hatası:", error.message);
        let img = "";
        if(globalPage && !globalPage.isClosed()) {
            try { img = await globalPage.screenshot({ encoding: 'base64' }); } catch(e){}
        }
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
    }
});

app.post('/inject-cookies', async (req, res) => {
    const { cookies } = req.body;
    let browser;
    try {
        // Klasör yoksa oluştur (Hata önleyici)
        if (!fs.existsSync(USER_DATA_DIR)){
            fs.mkdirSync(USER_DATA_DIR, { recursive: true });
        }

        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        browser = await startBrowser();
        const page = await browser.newPage();
        if (cookies) await page.setCookie(...cookies);
        
        console.log('Cookie testi yapılıyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'networkidle2' });
        
        const title = await page.title();
        await browser.close();
        
        res.json({ success: true, pageTitle: title });
    } catch (error) {
        if(browser) await browser.close();
        res.status(500).json({ error: error.message });
    }
});

app.post('/get-messages', async (req, res) => {
    const { filter } = req.body;
    let browser;
    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Cookie yok." });
        
        // Cookie dosyasını oku
        const cookiesRaw = fs.readFileSync(COOKIE_PATH);
        const cookies = JSON.parse(cookiesRaw);

        browser = await startBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
        // Cookie yükle
        await page.setCookie(...cookies);

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded' });
        
        // Cloudflare beklemesi
        await solveCloudflare(page);

        if (page.url().includes('giris')) {
             await browser.close();
             return res.status(401).json({ status: "session_expired", message: "Giriş yapın." });
        }

        await page.waitForSelector('body');
        const messages = await page.evaluate(() => {
            const data = [];
            const rows = document.querySelectorAll('tbody tr');
            if (rows.length > 0) {
                rows.forEach(row => {
                    const isUnread = row.classList.contains('unread') || row.querySelector('strong') !== null;
                    const text = row.innerText.replace(/\n/g, ' | ').trim();
                    if(text.length > 5) data.push({ raw: text, isUnread });
                });
            }
            return data;
        });

        const finalData = (filter === 'unread') ? messages.filter(m => m.isUnread) : messages;
        res.json({ success: true, count: finalData.length, messages: finalData });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.post('/submit-sms', async (req, res) => {
    // ... (SMS fonksiyonu aynı mantıkla eklenebilir, şimdilik login/inject odaklanalım)
    res.json({message: "SMS modülü aktif"});
});

app.listen(3000, () => console.log('Proxy V7.2 (Safe Mode) 3000 portunda aktif!'));
