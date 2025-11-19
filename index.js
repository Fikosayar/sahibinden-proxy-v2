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

// Gelişmiş Mouse Hareketi
async function humanClick(page, element) {
    const box = await element.boundingBox();
    if(!box) return;

    const x = box.x + (box.width / 2) + (Math.random() * 10 - 5); // Merkeze yakın rastgele nokta
    const y = box.y + (box.height / 2) + (Math.random() * 10 - 5);
    
    console.log(`Hedef koordinat: ${x}, ${y}`);

    // Yavaşça git
    await page.mouse.move(x, y, { steps: 25 });
    
    // Üzerinde bekle (Hover effect tetiklensin)
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    
    // Tıkla
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 100 + Math.random() * 50)); // Basılı tut
    await page.mouse.up();
    
    console.log('Mouse tıklandı.');
}

// CLOUDFLARE ÇÖZÜCÜ (Güncellendi)
async function solveCloudflare(page) {
    console.log("Cloudflare taraması başlıyor...");
    
    // 5 saniye bekle, sayfa tam otursun
    await new Promise(r => setTimeout(r, 5000));

    // Sayfadaki tüm frame'leri (iç pencereleri) gez
    const frames = page.frames();
    
    for (const frame of frames) {
        try {
            // Cloudflare genellikle bu checkbox'ı kullanır
            const checkbox = await frame.$('input[type="checkbox"]');
            if (checkbox) {
                console.log(">> Checkbox bulundu! Operasyon başlıyor...");
                await humanClick(page, checkbox);
                return true; // Bulduk ve tıkladık, çıkabiliriz
            }

            // Shadow DOM içinde olabilir
            const body = await frame.$('body');
            const text = await frame.evaluate(el => el.innerText, body);
            
            if (text.includes('Verify you are human') || text.includes('human')) {
                console.log(">> 'Verify' yazısı bulundu. Alana tıklanıyor...");
                await humanClick(page, body);
                return true;
            }
        } catch (e) {
            // Frame hatası önemsiz, sonrakine geç
        }
    }
    console.log("Tıklanacak aktif bir Cloudflare kutusu bulunamadı.");
    return false;
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
            '--start-maximized'
        ],
        executablePath: '/usr/bin/google-chrome'
    });
}

// LOGIN (Güncellendi)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        globalPage = page; // Global'e ata ki SMS gelirse oradan devam edelim

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 60000 });

        // Cloudflare Mücadelesi (Döngü ile kontrol et)
        for(let i=0; i<3; i++) {
            const title = await page.title();
            if(title.includes("Just a moment") || title.includes("Security")) {
                console.log(`Cloudflare tespit edildi. Deneme ${i+1}/3`);
                await solveCloudflare(page);
                await new Promise(r => setTimeout(r, 5000)); // Tıkladıktan sonra bekle
            } else {
                break; // Engel yoksa döngüden çık
            }
        }

        // Son kontrol
        const finalTitle = await page.title();
        if(finalTitle.includes("Just a moment")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ 
                 status: "error", 
                 message: "Cloudflare geçilemedi.", 
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

// SMS GİRME
app.post('/submit-sms', async (req, res) => {
    // (Önceki kodun aynısı)
    const { code } = req.body;
    try {
        globalBrowser = await startBrowser(); // Yeni browser aç (userDataDir oturumu hatırlar)
        const page = await globalBrowser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
        console.log('SMS sayfasına gidiliyor...');
        // Giriş sayfasına git, oturum yarım kaldığı için oradan devam etmeli veya direkt SMS ekranı gelmeli
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2' });

        await page.waitForSelector('input[type="text"]', { timeout: 10000 });
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

// MESAJ OKUMA
app.post('/get-messages', async (req, res) => {
    // (Önceki V6.2 kodunun aynısı, burası çalışıyor zaten)
    const { filter } = req.body;
    let browser;
    try {
        browser = await startBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded' });
        
        // Cloudflare tekrar çıkarsa çöz
        for(let i=0; i<2; i++) {
             const title = await page.title();
             if(title.includes("Just a moment")) await solveCloudflare(page);
             else break;
        }

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
                    data.push({ raw: text, isUnread });
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

app.listen(3000, () => console.log('Proxy V7.1 (Human Clicker) Hazır.'));
