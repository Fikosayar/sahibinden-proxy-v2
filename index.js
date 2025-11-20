const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

const USER_DATA_DIR = '/tmp/chrome_data_v10_2'; 
const COOKIE_PATH = '/tmp/cookies.json';

// --- WEBSHARE PROXY (ABD - Los Angeles) ---
const PROXY_IP = '142.111.48.253'; 
const PROXY_PORT = '7030';
const PROXY_USER = 'punmxuuv';
const PROXY_PASS = 'hqrh1cvutdb1';

let globalBrowser = null;
let globalPage = null;

async function humanClick(page, element) {
    try {
        const box = await element.boundingBox();
        if(!box) return;
        const x = box.x + (box.width / 2) + (Math.random() * 10 - 5);
        const y = box.y + (box.height / 2) + (Math.random() * 10 - 5);
        await page.mouse.move(x, y, { steps: 25 });
        await new Promise(r => setTimeout(r, 600));
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 150));
        await page.mouse.up();
    } catch(e) {}
}

async function solveCloudflare(page) {
    console.log("🔍 Cloudflare Taraması...");
    await new Promise(r => setTimeout(r, 5000)); 
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
    console.log('>>> Tarayıcı (US Proxy) başlatılıyor...');
    return await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
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
        globalPage = page;

        console.log('Proxy girişi yapılıyor...');
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        // İlk yükleme için 3 dakika veriyoruz
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'domcontentloaded', timeout: 180000 });

        // Cloudflare Kontrolü
        for(let i=0; i<3; i++) {
            const title = await page.title();
            if(title.includes("Just a moment") || title.includes("Security")) {
                console.log(`⚠️ Cloudflare (Deneme ${i+1})`);
                await solveCloudflare(page);
                await new Promise(r => setTimeout(r, 8000)); 
            } else break;
        }

        const finalTitle = await page.title();
        if(finalTitle.includes("Just a moment")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ status: "error", message: "Cloudflare geçilemedi.", debug_image: `<img src="data:image/png;base64,${shot}" />` });
        }

        console.log('Form bekleniyor...');
        await page.waitForSelector('#username', { visible: true, timeout: 60000 });

        console.log('Bilgiler giriliyor...');
        await page.type('#username', username, { delay: 150 });
        await page.type('#password', password, { delay: 150 });
        
        console.log('Giriş yapılıyor...');
        
        // BURASI KRİTİK: Navigation Timeout olsa bile hata verme, devam et!
        await Promise.all([
            page.click('#userLoginSubmitButton'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 })
                .catch(e => console.log("⚠️ Navigasyon zaman aşımı (Önemsiz, devam ediliyor...)"))
        ]);

        // Biraz bekle ki sayfa otursun
        await new Promise(r => setTimeout(r, 5000));

        const content = await page.content();
        
        // SMS Kontrolü
        if (content.includes("Doğrulama Kodu") || content.includes("verification code")) {
            console.log('SMS İstendi.');
            const shot = await page.screenshot({ encoding: 'base64' });
            return res.json({ 
                status: "sms_required", 
                message: "SMS kodu gerekli.",
                debug_image: `<img src="data:image/png;base64,${shot}" />`
            });
        }

        // Başarılı mı?
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        // Başarı durumunda bile ne gördüğünü çekelim (Emin olmak için)
        const shot = await page.screenshot({ encoding: 'base64' });

        await globalBrowser.close();
        res.json({ 
            status: "success", 
            message: "Giriş Başarılı!", 
            debug_image: `<img src="data:image/png;base64,${shot}" />` // Nereye girdiğini gör
        });

    } catch (error) {
        console.error("Hata:", error.message);
        let img = "";
        // Hata anında ekran görüntüsü al
        try { if(globalPage) img = await globalPage.screenshot({ encoding: 'base64' }); } catch(e){}
        
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
    }
});

// --- SMS GİRME ---
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    try {
        console.log("SMS Onayı için tarayıcı açılıyor...");
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 90000 });

        console.log("SMS Kodu yazılıyor...");
        await page.waitForSelector('input[type="text"]', { timeout: 60000 });
        await page.type('input[type="text"]', code, { delay: 200 });
        
        await Promise.all([
            page.click('button[type="submit"]'), 
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 })
                 .catch(e => console.log("SMS sonrası navigasyon timeout (Önemsiz)"))
        ]);
        
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));

        await globalBrowser.close();
        res.json({ status: "success", message: "SMS Onaylandı." });
    } catch (error) {
        let img = "";
        try { if(globalPage) img = await globalPage.screenshot({ encoding: 'base64' }); } catch(e){}
        res.status(500).json({ error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
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

        // Cloudflare kontrol
        for(let i=0; i<2; i++) {
             const title = await page.title();
             if(title.includes("Just a moment")) await solveCloudflare(page);
             else break;
        }

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
                    const linkElement = row.querySelector('a');
                    const link = linkElement ? linkElement.href : null;
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

// --- CEVAP YAZMA ---
app.post('/send-reply', async (req, res) => {
    const { messageLink, replyText } = req.body;
    let browser;
    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Giriş yapılmamış" });
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Sohbet detayına gidiliyor...');
        await page.goto(messageLink, { waitUntil: 'domcontentloaded', timeout: 120000 });
        
        const textareaSelector = 'textarea'; 
        await page.waitForSelector(textareaSelector, { timeout: 30000 });
        await page.type(textareaSelector, replyText);
        
        console.log('Gönderiliyor...');
        await page.click('button[type="submit"]'); 
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(e=>console.log("Gönderim timeout (Önemsiz)"));

        res.json({ success: true, message: "Cevap gönderildi." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(3000, () => console.log('Proxy V10.2 (Patient Mode) Hazır.'));
