const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

// AYARLAR
const USER_DATA_DIR = '/tmp/chrome_data_v9'; // Yeni temiz klasör
const COOKIE_PATH = '/tmp/cookies.json';

// SCRAPE.DO AYARLARI
const PROXY_SERVER = 'http://proxy.scrape.do:8080';
const PROXY_USER = '5052db1d887f45fa9533370a97d6f6c4c3552fb1e9d'; // Senin Token'ın
const PROXY_PASS = ''; // Şifre gerekmiyor genelde

let globalBrowser = null;
let globalPage = null;

// Tarayıcı Başlatma (Proxy Entegreli)
async function startBrowser() {
    console.log('>>> Tarayıcı (Scrape.do Proxy) başlatılıyor...');
    return await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            // İŞTE SİHİRLİ KOMUT: Tüm trafiği Scrape.do üzerinden geçir
            `--proxy-server=${PROXY_SERVER}`
        ],
        executablePath: '/usr/bin/google-chrome'
    });
}

// Sayfa açılınca Proxy'ye şifre ile giriş yap
async function authProxy(page) {
    console.log('Proxy kimlik doğrulaması yapılıyor...');
    await page.authenticate({ 
        username: PROXY_USER, 
        password: PROXY_PASS 
    });
}

// --- LOGIN ---
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        globalPage = page;

        // Önce Proxy'ye giriş yap
        await authProxy(page);

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor (Proxy ile)...');
        // Timeout'u uzun tutuyoruz çünkü Proxy bazen yavaş olabilir
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 120000 });

        console.log('Sayfa yüklendi. Başlık kontrol ediliyor...');
        const title = await page.title();
        console.log(`Başlık: ${title}`);

        // Cloudflare Engel Kontrolü
        if(title.includes("Just a moment")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             // Proxy olduğu için bekleyince geçebilir, hemen kapatmayalım
             return res.status(403).json({ 
                 status: "error", 
                 message: "Proxy'ye rağmen Cloudflare çıktı. (Debug image'a bak)", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
        }

        console.log('Giriş formu aranıyor...');
        try {
            await page.waitForSelector('#username', { visible: true, timeout: 30000 });
        } catch(e) {
            const shot = await page.screenshot({ encoding: 'base64' });
            await globalBrowser.close();
            return res.status(500).json({ status: "error", message: "Form bulunamadı.", debug_image: `<img src="data:image/png;base64,${shot}" />` });
        }

        console.log('Bilgiler yazılıyor...');
        await page.type('#username', username, { delay: 150 });
        await page.type('#password', password, { delay: 150 });
        
        await Promise.all([
            page.click('#userLoginSubmitButton'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        ]);

        // SMS Kontrolü
        const content = await page.content();
        if (content.includes("Doğrulama Kodu") || content.includes("verification code")) {
            console.log('SMS istendi.');
            const shot = await page.screenshot({ encoding: 'base64' });
            return res.json({ 
                status: "sms_required", 
                message: "SMS kodu gerekli. /submit-sms kullanın.",
                debug_image: `<img src="data:image/png;base64,${shot}" />`
            });
        }

        // Cookie Kaydet
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        await globalBrowser.close();
        res.json({ status: "success", message: "Giriş Başarılı! (Proxy Aktif)" });

    } catch (error) {
        console.error(error);
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message });
    }
});

// --- SMS GİRME ---
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    try {
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        await authProxy(page); // Proxy login
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Oturum korunduğu için tekrar giriş sayfasına gidince kaldığı yerden devam etmeli
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2' });

        await page.waitForSelector('input[type="text"]', { timeout: 15000 });
        await page.type('input[type="text"]', code, { delay: 200 });
        await page.click('button[type="submit"]'); 
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        
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
        await authProxy(page); // Proxy login

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded' });

        if (page.url().includes('giris')) {
             await browser.close();
             return res.status(401).json({ status: "session_expired", message: "Tekrar /login yapın." });
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
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(3000, () => console.log('Proxy V9 (Scrape.do Integration) Hazır.'));
