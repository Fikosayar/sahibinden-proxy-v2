const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Stealth Eklentisi (Cloudflare için en önemli silahımız)
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '50mb' }));

const USER_DATA_DIR = '/tmp/chrome_data_v8'; // Temiz bir başlangıç için yeni klasör
const COOKIE_PATH = '/tmp/cookies.json';

let globalBrowser = null;
let globalPage = null;

// --- GELİŞMİŞ MOUSE HAREKETİ ---
async function humanMoveAndClick(page, element) {
    try {
        const box = await element.boundingBox();
        if(!box) return;
        
        // Hedefin biraz sağına soluna saparak git
        const x = box.x + (box.width / 2) + (Math.random() * 20 - 10);
        const y = box.y + (box.height / 2) + (Math.random() * 20 - 10);
        
        // Yavaş yaklaş
        await page.mouse.move(x, y, { steps: 25 });
        
        // İnsan gibi tereddüt et (Hover)
        await new Promise(r => setTimeout(r, 800 + Math.random() * 500));
        
        // Tıkla
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 150)); // Basılı tutma süresi
        await page.mouse.up();
        
        console.log('>>> Mouse ile tıklandı.');
    } catch (e) { console.log("Mouse hatası:", e.message); }
}

// --- CLOUDFLARE ÇÖZÜCÜ (SHADOW DOM) ---
async function solveCloudflare(page) {
    console.log("🔍 Cloudflare Taraması Başlatılıyor...");
    await new Promise(r => setTimeout(r, 4000)); // Sayfanın oturmasını bekle

    const frames = page.frames();
    for (const frame of frames) {
        try {
            // 1. Yöntem: Standart Checkbox
            const checkbox = await frame.$('input[type="checkbox"]');
            if (checkbox) {
                console.log("✅ Checkbox bulundu, tıklanıyor...");
                await humanMoveAndClick(page, checkbox);
                return true;
            }

            // 2. Yöntem: Shadow DOM içindeki verify butonu
            // Cloudflare bazen kendini ShadowRoot içine gizler
            const challenge = await frame.$('#turnstile-wrapper'); 
            if (challenge) {
                 console.log("✅ Turnstile Wrapper bulundu, tıklanıyor...");
                 await humanMoveAndClick(page, challenge);
                 return true;
            }

            // 3. Yöntem: Body Text Kontrolü (Verify yazısı)
            const body = await frame.$('body');
            const text = await frame.evaluate(el => el.innerText, body);
            if (text.includes('Verify you are human') || text.includes('human')) {
                console.log("✅ 'Verify' yazısı bulundu, ortasına tıklanıyor...");
                await humanMoveAndClick(page, body);
                return true;
            }
        } catch (e) {}
    }
    console.log("❌ Tıklanacak kutu bulunamadı (Zaten geçmiş olabiliriz).");
    return false;
}

// --- TARAYICI BAŞLATMA (KAMUFLAJ MODU) ---
async function startBrowser() {
    console.log('>>> Tarayıcı V8 (Stealth Mode) başlatılıyor...');
    return await puppeteer.launch({
        headless: "new", 
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1366,768', // Standart Laptop Çözünürlüğü
            '--disable-blink-features=AutomationControlled', // Bot olduğunu gizle
            '--disable-infobars',
            '--disable-features=IsolateOrigins,site-per-process',
            '--lang=tr-TR,tr'
        ],
        ignoreDefaultArgs: ['--enable-automation'], // Otomasyon bayraklarını yoksay
        executablePath: '/usr/bin/google-chrome'
    });
}

// --- LOGIN ENDPOINT ---
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        globalPage = page;

        // Windows 10 / Chrome User Agent Taklidi
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Webdriver izini sil
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        console.log('Giriş sayfasına gidiliyor...');
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 90000 });

        // Cloudflare Döngüsü (3 Kez Dene)
        for(let i=0; i<3; i++) {
            const title = await page.title();
            if(title.includes("Just a moment") || title.includes("Security") || title.includes("sahibinden.com")) {
                // Sahibinden.com bazen başlıkta sadece domain yazar ama içerik CF'dir
                const content = await page.content();
                if(content.includes("Verify you are human")) {
                    console.log(`⚠️ Cloudflare Tespit Edildi (Deneme ${i+1})`);
                    await solveCloudflare(page);
                    console.log("⏳ Tıklama sonrası 8 saniye bekleniyor...");
                    await new Promise(r => setTimeout(r, 8000)); 
                } else {
                    console.log("✅ Cloudflare engeli yok gibi görünüyor.");
                    break;
                }
            } else {
                break;
            }
        }

        // Kontrol: Hala takıldık mı?
        const finalTitle = await page.title();
        if(finalTitle.includes("Just a moment")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ 
                 status: "error", 
                 message: "IP adresi Cloudflare tarafından bloklanıyor (Spinner dönüyor).", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
        }

        console.log('Giriş formu aranıyor...');
        try {
            await page.waitForSelector('#username', { visible: true, timeout: 20000 });
        } catch(e) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(500).json({ 
                 status: "error", 
                 message: "Giriş formu gelmedi. Ekran görüntüsüne bakın.", 
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

        const content = await page.content();
        if (content.includes("Doğrulama Kodu") || content.includes("verification code")) {
            const shot = await page.screenshot({ encoding: 'base64' });
            return res.json({ 
                status: "sms_required", 
                message: "SMS kodu gerekli.",
                debug_image: `<img src="data:image/png;base64,${shot}" />`
            });
        }

        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        await globalBrowser.close();
        res.json({ status: "success", message: "Giriş Başarılı! (V8)" });

    } catch (error) {
        console.error(error);
        let img = "";
        try { if(globalPage) img = await globalPage.screenshot({ encoding: 'base64' }); } catch(e){}
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
    }
});

// --- SMS VE MESAJ OKUMA (Aynı Kalıyor) ---
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    // ... (Burası aynı, kısa tuttum yer kaplamasın diye) ...
    res.json({ message: "SMS Modülü aktif" });
});

app.post('/get-messages', async (req, res) => {
    // ... (V6.2 deki kodun aynısı) ...
    res.json({ message: "Mesaj Modülü aktif" }); 
    // Not: Asıl kullanırken önceki koddan get-messages kısmını buraya kopyalamalısın!
});

app.listen(3000, () => console.log('Proxy V8 (Deep Stealth) Hazır.'));
