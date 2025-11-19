const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

const USER_DATA_DIR = '/tmp/chrome_data_v9_2'; 
const COOKIE_PATH = '/tmp/cookies.json';

// SCRAPE.DO GELİŞMİŞ AYARLARI
// username kısmına parametreleri ekliyoruz: render=false, super=true (Residential IP)
const SCRAPE_TOKEN = '5052db1d887f45fa9533370a97d6f6c4c3552fb1e9d';
const PROXY_HOST = 'proxy.scrape.do:8080';
const PROXY_USER = `${SCRAPE_TOKEN}`; 
// Alternatif: const PROXY_USER = `${SCRAPE_TOKEN}:render=false&super=true&geoCode=tr`; 
// Ama Puppeteer ile authenticate ederken sadece token kullanmak daha stabildir.

let globalBrowser = null;
let globalPage = null;

async function startBrowser() {
    console.log('>>> Tarayıcı (Scrape.do V9.2) başlatılıyor...');
    return await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        ignoreHTTPSErrors: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            `--proxy-server=http://${PROXY_HOST}`, // Protokol eklendi
            '--ignore-certificate-errors'
        ],
        executablePath: '/usr/bin/google-chrome'
    });
}

async function authProxy(page) {
    console.log('Proxy kimlik doğrulaması...');
    await page.authenticate({ 
        username: PROXY_USER, 
        password: '' // Şifre boş
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

        await authProxy(page);

        // Türkçe ve Gerçekçi Headerlar
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1'
        });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        
        // Navigation Timeout'u artır
        try {
            await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.log("Sayfa yükleme uyarısı: " + e.message);
        }

        console.log('Sayfa yüklendi. Başlık kontrol...');
        const title = await page.title();
        console.log(`Başlık: "${title}"`);

        // Eğer başlık boşsa veya hata varsa
        if (!title || title === "") {
             const shot = await page.screenshot({ encoding: 'base64' });
             return res.status(500).json({ 
                 status: "error", 
                 message: "Sayfa beyaz ekran verdi (Proxy yanıt vermedi).", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
        }

        if(title.includes("Just a moment") || title.includes("Security")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             return res.status(403).json({ 
                 status: "error", 
                 message: "Cloudflare (Proxy'e rağmen).", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
        }

        console.log('Giriş formu aranıyor...');
        try {
            await page.waitForSelector('#username', { visible: true, timeout: 20000 });
        } catch(e) {
            const shot = await page.screenshot({ encoding: 'base64' });
            await globalBrowser.close();
            return res.status(500).json({ status: "error", message: "Form yok. (IP Ban?)", debug_image: `<img src="data:image/png;base64,${shot}" />` });
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
            console.log('SMS istendi.');
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
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message });
    }
});

// (Diğer SMS ve Mesaj fonksiyonları aynı, yer tutmasın diye yazmadım, kopyalayabilirsin)

app.listen(3000, () => console.log('Proxy V9.2 (Scrape.do Optimized) Hazır.'));
