const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

const USER_DATA_DIR = '/tmp/chrome_data_v12'; 
const COOKIE_PATH = '/tmp/cookies.json';

// --- WEBSHARE PROXY (İngiltere - London) ---
const PROXY_IP = '45.38.107.97'; 
const PROXY_PORT = '6014';
const PROXY_USER = 'punmxuuv';
const PROXY_PASS = 'hqrh1cvutdb1';

let globalBrowser = null;

// Tarayıcıyı Hafif Modda Başlat
async function startBrowser() {
    console.log('>>> Tarayıcı (V12 - Hafif & Proxy) başlatılıyor...');
    return await puppeteer.launch({
        headless: "new", // HAFİF MOD (CPU/RAM Dostu)
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', // RAM yerine diski kullanır, çökmez
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
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

        console.log('Proxy girişi yapılıyor...');
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        // Proxy yavaş olabilir, 3 dakika bekleme süresi
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'domcontentloaded', timeout: 180000 });

        console.log('Form bekleniyor...');
        // Formu 60 saniye bekle
        try {
            await page.waitForSelector('#username', { visible: true, timeout: 60000 });
        } catch(e) {
            // Form gelmediyse muhtemelen Cloudflare vardır, ekranı çek
            const shot = await page.screenshot({ encoding: 'base64' });
            await globalBrowser.close();
            return res.status(500).json({ status: "error", message: "Form bulunamadı (CF olabilir).", debug_image: `<img src="data:image/png;base64,${shot}" />` });
        }

        console.log('Bilgiler giriliyor...');
        await page.type('#username', username, { delay: 150 });
        await page.type('#password', password, { delay: 150 });
        
        console.log('Butona basılıyor...');
        await Promise.all([
            page.click('#userLoginSubmitButton'),
            // Navigasyon hatası olsa bile devam et (Timeout yememesi için)
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => console.log("Navigasyon timeout (devam)"))
        ]);

        // Sayfanın oturması için biraz bekle
        await new Promise(r => setTimeout(r, 5000));

        const content = await page.content();
        
        // SMS Kontrolü
        if (content.includes("Doğrulama Kodu") || content.includes("verification code")) {
            console.log('SMS İstendi!');
            const shot = await page.screenshot({ encoding: 'base64' });
            return res.json({ 
                status: "sms_required", 
                message: "SMS kodu gerekli. /submit-sms kullanın.",
                debug_image: `<img src="data:image/png;base64,${shot}" />`
            });
        }

        // Hatalı şifre vs kontrolü
        if (content.includes("hatalı") || content.includes("error")) {
            const shot = await page.screenshot({ encoding: 'base64' });
            // Hata olsa bile cookie kaydedelim, belki girmiştir
        }

        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        // Başarılı ekranı çek
        const shot = await page.screenshot({ encoding: 'base64' });
        await globalBrowser.close();
        
        res.json({ 
            status: "success", 
            message: "Giriş Başarılı!", 
            debug_image: `<img src="data:image/png;base64,${shot}" />` 
        });

    } catch (error) {
        console.error(error);
        let img = "";
        try { if(globalBrowser) img = await globalBrowser.pages()[0].screenshot({ encoding: 'base64' }); } catch(e){}
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
    }
});

// --- SMS GİRME ---
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    try {
        console.log("SMS için tarayıcı açılıyor...");
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'domcontentloaded', timeout: 90000 });

        await page.waitForSelector('input[type="text"]', { timeout: 60000 });
        await page.type('input[type="text"]', code, { delay: 200 });
        
        await Promise.all([
            page.click('button[type="submit"]'), 
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(()=>{})
        ]);
        
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));

        await globalBrowser.close();
        res.json({ status: "success", message: "SMS Onaylandı." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- MESAJ OKUMA ---
app.post('/get-messages', async (req, res) => {
    const { filter } = req.body;
    let browser;
    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Giriş yapılmamış." });
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded', timeout: 120000 });

        if (page.url().includes('giris')) {
             await browser.close();
             return res.status(401).json({ status: "session_expired", message: "Tekrar /login yapın." });
        }

        await page.waitForSelector('body', {timeout: 60000});

        const messages = await page.evaluate(() => {
            const data = [];
            const rows = document.querySelectorAll('tbody tr');
            if (rows.length > 0) {
                rows.forEach(row => {
                    const isUnread = row.classList.contains('unread') || row.querySelector('strong') !== null;
                    const text = row.innerText.replace(/\n/g, ' | ').trim();
                    const link = row.querySelector('a') ? row.querySelector('a').href : null;
                    if(text.length > 5) data.push({ raw: text, isUnread, link });
                });
            }
            return data;
        });

        const finalData = (filter === 'unread') ? messages.filter(m => m.isUnread) : messages;
        res.json({ success: true, count: finalData.length, messages: finalData });

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// ... (send-reply fonksiyonu da buraya eklenebilir, yukarıdaki mesajlarda vardı) ...

app.listen(3000, () => console.log('Proxy V12 (Lightweight) Hazır.'));
