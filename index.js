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
let globalPage = null;

// İnsan Tıklaması (Aynen kalıyor, iyi çalışıyor)
async function humanClick(page, element) {
    const box = await element.boundingBox();
    if(!box) return;
    const x = box.x + (box.width / 2) + (Math.random() * 10 - 5); 
    const y = box.y + (box.height / 2) + (Math.random() * 10 - 5);
    await page.mouse.move(x, y, { steps: 25 });
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 100 + Math.random() * 50));
    await page.mouse.up();
}

async function solveCloudflare(page) {
    console.log("Cloudflare taraması...");
    await new Promise(r => setTimeout(r, 3000));
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const checkbox = await frame.$('input[type="checkbox"]');
            if (checkbox) {
                console.log(">> Checkbox bulundu!");
                await humanClick(page, checkbox);
                return true; 
            }
            const body = await frame.$('body');
            const text = await frame.evaluate(el => el.innerText, body);
            if (text.includes('Verify you are human')) {
                console.log(">> Verify yazısı bulundu!");
                await humanClick(page, body);
                return true;
            }
        } catch (e) {}
    }
    return false;
}

// GELİŞMİŞ TARAYICI BAŞLATMA (V8 - KAMUFLAJ)
async function startBrowser() {
    return await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled', // Bot izini sil
            '--disable-infobars',
            '--no-zygote',
            '--lang=tr-TR,tr', // Türkçe tarayıcı gibi görün
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        executablePath: '/usr/bin/google-chrome'
    });
}

// LOGIN
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        globalPage = page;

        // Gerçekçi User-Agent ve Viewport
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        // Ekstra Gizlilik: Webdriver özelliğini sil
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
        });

        console.log('Giriş sayfasına gidiliyor...');
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 60000 });

        // Cloudflare Döngüsü
        for(let i=0; i<3; i++) {
            const title = await page.title();
            if(title.includes("Just a moment") || title.includes("Security")) {
                console.log(`Cloudflare tespit edildi. Deneme ${i+1}/3`);
                await solveCloudflare(page);
                await new Promise(r => setTimeout(r, 5000)); 
            } else {
                break; 
            }
        }

        // Kontrol
        const finalTitle = await page.title();
        if(finalTitle.includes("Just a moment")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ 
                 status: "error", 
                 message: "Cloudflare geçilemedi (IP kara listede olabilir).", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
        }

        console.log('Giriş formu aranıyor...');
        await page.waitForSelector('#username', { visible: true, timeout: 20000 });

        console.log('Bilgiler yazılıyor...');
        await page.type('#username', username, { delay: 100 });
        await page.type('#password', password, { delay: 100 });
        
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
        res.json({ status: "success", message: "Giriş Başarılı!" });

    } catch (error) {
        console.error(error);
        let img = "";
        try { img = await globalPage.screenshot({ encoding: 'base64' }); } catch(e){}
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
    }
});

// (Diğer fonksiyonlar aynı: /submit-sms, /get-messages vb.)
// ... (Kopyalarken /submit-sms ve /get-messages fonksiyonlarını da eklemeyi unutma, önceki koddan alabilirsin)
// (Eğer üşenirsen söyle, tam kodu tek parça vereyim)
// ...
