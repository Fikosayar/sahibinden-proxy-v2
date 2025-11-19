const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

const USER_DATA_DIR = './chrome_data'; 
const COOKIE_PATH = './cookies.json';
let globalBrowser = null;

// İNSAN GİBİ MOUSE HAREKETİ (Mouse Jiggler)
async function humanMove(page, element) {
    const box = await element.boundingBox();
    const x = box.x + (box.width / 2);
    const y = box.y + (box.height / 2);
    
    // Rastgele sapmalarla hedefe git
    await page.mouse.move(x + 10, y + 10, { steps: 25 });
    await page.mouse.move(x, y, { steps: 10 });
    await new Promise(r => setTimeout(r, Math.random() * 500 + 200)); // Biraz bekle
}

// CLOUDFLARE KUTUSUNU BUL VE TIKLA
async function solveCloudflare(page) {
    try {
        console.log("Cloudflare kontrolü yapılıyor...");
        await new Promise(r => setTimeout(r, 3000));

        // Sayfadaki iframe'leri kontrol et (Turnstile genellikle iframe içindedir)
        const frames = page.frames();
        let clicked = false;

        for (const frame of frames) {
            // Doğrulama kutusu genellikle bu selector'da olur
            try {
                const checkbox = await frame.$('input[type="checkbox"]');
                if (checkbox) {
                    console.log("Doğrulama kutusu bulundu! İnsan gibi tıklanıyor...");
                    await humanMove(page, checkbox);
                    await checkbox.click();
                    clicked = true;
                    break; 
                }
                
                // Alternatif Cloudflare yapısı (Shadow DOM)
                const body = await frame.$('body');
                if(body) {
                    const text = await frame.evaluate(el => el.innerText, body);
                    if(text.includes('Verify') || text.includes('human')) {
                        console.log("Verify yazısı bulundu, ortasına tıklanıyor...");
                        await humanMove(page, body);
                        await body.click();
                        clicked = true;
                        break;
                    }
                }
            } catch (e) {}
        }

        if(clicked) {
            console.log("Tıklandı. Sonuç bekleniyor...");
            await new Promise(r => setTimeout(r, 5000)); // Geçişi bekle
        } else {
            console.log("Tıklanacak kutu bulunamadı, belki de çıkmamıştır.");
        }

    } catch (e) {
        console.log("Cloudflare çözümleme hatası: " + e.message);
    }
}

async function startBrowser() {
    return await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized' // Tam ekran başlat
        ],
        executablePath: '/usr/bin/google-chrome'
    });
}

// 1. HER HESAP İÇİN GİRİŞ FONKSİYONU
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 60000 });

        // Cloudflare Engeli Var mı? Varsa Çöz.
        await solveCloudflare(page);

        // Başlık kontrolü (Hala engel var mı?)
        const title = await page.title();
        if(title.includes("Just a moment") || title.includes("Security")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ 
                 status: "error", 
                 message: "Cloudflare kutusu aşılamadı.", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
        }

        console.log('Giriş formu bekleniyor...');
        try {
            await page.waitForSelector('#username', { visible: true, timeout: 15000 });
        } catch(e) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(500).json({ 
                 status: "error", 
                 message: "Giriş formu bulunamadı (Hala Cloudflare olabilir).", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
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
            // Tarayıcıyı açık bırak (Global değişkende)
            globalPage = page; 
            return res.json({ status: "sms_required", message: "/submit-sms ile kodu gönderin." });
        }

        // Başarılı
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        await globalBrowser.close();
        globalBrowser = null;
        
        res.json({ status: "success", message: "Giriş Başarılı!" });

    } catch (error) {
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ error: error.message });
    }
});

// 2. SMS GİRME (Global Page Kullanır)
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    if (!globalPage) return res.status(400).json({ error: "Aktif oturum yok." });

    try {
        await globalPage.waitForSelector('input[type="text"]', { timeout: 5000 });
        await globalPage.type('input[type="text"]', code, { delay: 200 });
        
        await Promise.all([
            globalPage.click('button[type="submit"]'), 
            globalPage.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);
        
        const cookies = await globalPage.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));

        await globalBrowser.close();
        globalBrowser = null;
        res.json({ status: "success", message: "SMS Onaylandı." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. MESAJ OKUMA (Okunmamış Filtresiyle)
app.post('/get-messages', async (req, res) => {
    const { filter } = req.body;
    let browser;
    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Giriş yapılmamış." });
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded' });
        
        // Cloudflare tekrar çıkarsa çözmeyi dene
        await solveCloudflare(page);

        // Oturum kontrolü
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
                    // Okunmamış mesaj tespiti (Sahibinden'de genellikle 'unread' classı veya strong etiketi olur)
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

app.listen(3000, () => console.log('Proxy V7 (Cloudflare Hunter) Hazır.'));
