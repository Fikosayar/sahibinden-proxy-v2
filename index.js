const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' }));

// Hata durumunda oturumun silinmemesi için kalıcı klasör
const USER_DATA_DIR = '/tmp/chrome_data_v11'; 
const COOKIE_PATH = '/tmp/cookies.json';

// --- WEBSHARE PROXY BİLGİLERİ (İNGİLTERE - LONDON) ---
// Listendeki 45.38.107.97 IP'sini kullandım.
const PROXY_IP = '45.38.107.97'; 
const PROXY_PORT = '6014';
const PROXY_USER = 'punmxuuv';
const PROXY_PASS = 'hqrh1cvutdb1';

let globalBrowser = null;
let globalPage = null;

// --- YARDIMCI FONKSİYONLAR ---

// İnsan gibi Mouse Hareketi ve Tıklama
async function humanClick(page, element) {
    try {
        const box = await element.boundingBox();
        if(!box) return;
        
        // Hedefin merkezine yakın rastgele bir nokta
        const x = box.x + (box.width / 2) + (Math.random() * 10 - 5);
        const y = box.y + (box.height / 2) + (Math.random() * 10 - 5);
        
        // Yavaşça hedefe git
        await page.mouse.move(x, y, { steps: 25 });
        
        // Üzerinde biraz bekle (Hover effect)
        await new Promise(r => setTimeout(r, 600 + Math.random() * 300));
        
        // Tıkla
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 150 + Math.random() * 100));
        await page.mouse.up();
        
        console.log('>>> Mouse ile tıklandı.');
    } catch(e) { 
        console.log("Mouse hatası:", e.message); 
    }
}

// Cloudflare Çözücü (Döngüsel Kontrol)
async function solveCloudflare(page) {
    console.log("🔍 Cloudflare Taraması...");
    await new Promise(r => setTimeout(r, 5000)); // Sayfanın oturmasını bekle

    const frames = page.frames();
    for (const frame of frames) {
        try {
            // 1. Checkbox Kontrolü
            const checkbox = await frame.$('input[type="checkbox"]');
            if (checkbox) {
                console.log("✅ Checkbox bulundu, tıklanıyor...");
                await humanClick(page, checkbox);
                return true;
            }

            // 2. 'Verify' Yazısı Kontrolü
            const body = await frame.$('body');
            const text = await frame.evaluate(el => el.innerText, body);
            if (text.includes('Verify you are human')) {
                console.log("✅ 'Verify' yazısı bulundu, ortasına tıklanıyor...");
                await humanClick(page, body);
                return true;
            }
        } catch (e) {}
    }
    return false;
}

// Tarayıcıyı Başlatma (V11 - Görünür Mod)
async function startBrowser() {
    console.log('>>> Tarayıcı (V11 - Headless:False) başlatılıyor...');
    return await puppeteer.launch({
        headless: false, // BURASI ÇOK ÖNEMLİ: Xvfb sayesinde gerçek ekran varmış gibi çalışacak
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1280,1024', // Gerçekçi ekran boyutu
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            `--proxy-server=${PROXY_IP}:${PROXY_PORT}` // Proxy Tüneli
        ],
        executablePath: '/usr/bin/google-chrome'
    });
}

// Proxy Kimlik Doğrulama Yardımcısı
async function authProxy(page) {
    console.log('Proxy kimlik doğrulaması yapılıyor...');
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
}

// --- ENDPOINTLER ---

// 1. GİRİŞ (LOGIN)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        // Temiz başlangıç
        if (globalBrowser) await globalBrowser.close();
        
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        globalPage = page; // SMS için sakla

        await authProxy(page);

        // Gerçekçi User-Agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        // Proxy yavaş olabilir, süre 3 dakika
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'domcontentloaded', timeout: 180000 });

        // Cloudflare Kontrolü (3 Tur)
        for(let i=0; i<3; i++) {
            const title = await page.title();
            // Başlıkta şüpheli kelimeler varsa CF'dir
            if(title.includes("Just a moment") || title.includes("Security") || title.includes("sahibinden.com")) {
                console.log(`⚠️ Cloudflare Kontrolü (Deneme ${i+1})`);
                const solved = await solveCloudflare(page);
                if(solved) console.log("Tıklama yapıldı, bekleniyor...");
                await new Promise(r => setTimeout(r, 8000)); 
            } else {
                console.log("Engel yok, devam ediliyor...");
                break;
            }
        }

        // Son Kontrol: Hala CF var mı?
        const finalTitle = await page.title();
        if(finalTitle.includes("Just a moment") || finalTitle.includes("Security")) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(403).json({ 
                 status: "error", 
                 message: "Proxy'ye rağmen Cloudflare geçilemedi. (IP Block)", 
                 debug_image: `<img src="data:image/png;base64,${shot}" />` 
             });
        }

        console.log('Giriş formu aranıyor...');
        // Formun yüklenmesini bekle (1dk)
        try {
            await page.waitForSelector('#username', { visible: true, timeout: 60000 });
        } catch(e) {
             const shot = await page.screenshot({ encoding: 'base64' });
             await globalBrowser.close();
             return res.status(500).json({ status: "error", message: "Form bulunamadı.", debug_image: `<img src="data:image/png;base64,${shot}" />` });
        }

        console.log('Bilgiler giriliyor...');
        await page.type('#username', username, { delay: 150 });
        await page.type('#password', password, { delay: 150 });
        
        console.log('Giriş butonuna basılıyor...');
        await Promise.all([
            page.click('#userLoginSubmitButton'),
            // Navigasyon zaman aşımına uğrarsa hata verme, devam et
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => console.log("Navigasyon timeout (devam ediliyor)"))
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

        // Hatalı şifre kontrolü
        if (content.includes("E-posta adresiniz veya şifreniz hatalı")) {
             await globalBrowser.close();
             return res.status(400).json({ status: "error", message: "Kullanıcı adı veya şifre hatalı." });
        }

        // Cookie Kaydet
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        
        const shot = await page.screenshot({ encoding: 'base64' });
        await globalBrowser.close();
        
        res.json({ 
            status: "success", 
            message: "Giriş Başarılı!", 
            debug_image: `<img src="data:image/png;base64,${shot}" />` 
        });

    } catch (error) {
        console.error("Login Hatası:", error);
        let img = "";
        try { if(globalPage) img = await globalPage.screenshot({ encoding: 'base64' }); } catch(e){}
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message, debug_image: `<img src="data:image/png;base64,${img}" />` });
    }
});

// 2. SMS GİRİŞİ (SUBMIT SMS)
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    try {
        console.log("SMS için tarayıcı açılıyor...");
        globalBrowser = await startBrowser();
        const page = await globalBrowser.newPage();
        await authProxy(page);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Oturum cookie'den veya userDataDir'den devam eder
        await page.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 90000 });

        console.log("SMS Kodu yazılıyor...");
        await page.waitForSelector('input[type="text"]', { timeout: 60000 });
        await page.type('input[type="text"]', code, { delay: 200 });
        
        await Promise.all([
            page.click('button[type="submit"]'), 
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 }).catch(() => {})
        ]);
        
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));

        await globalBrowser.close();
        res.json({ status: "success", message: "SMS Onaylandı." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. MESAJLARI OKU (GET MESSAGES)
app.post('/get-messages', async (req, res) => {
    const { filter } = req.body;
    let browser;
    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Giriş yapılmamış." });
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await authProxy(page);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.setCookie(...cookies);

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded', timeout: 120000 });

        // Cloudflare varsa çöz
        for(let i=0; i<2; i++) {
             const title = await page.title();
             if(title.includes("Just a moment")) await solveCloudflare(page);
             else break;
        }

        // Login sayfasına attıysa oturum bitmiş demektir
        if (page.url().includes('giris')) {
             await browser.close();
             return res.status(401).json({ status: "session_expired", message: "Tekrar /login yapın." });
        }

        await page.waitForSelector('body', {timeout: 60000});

        // Verileri Çek
        const messages = await page.evaluate(() => {
            const data = [];
            const rows = document.querySelectorAll('tbody tr');
            if (rows.length > 0) {
                rows.forEach(row => {
                    const isUnread = row.classList.contains('unread') || row.querySelector('strong') !== null;
                    const text = row.innerText.replace(/\n/g, ' | ').trim();
                    // Linki al (Cevap yazmak için lazım)
                    const linkElement = row.querySelector('a');
                    const link = linkElement ? linkElement.href : null;

                    if(text.length > 5) data.push({ raw: text, isUnread, link });
                });
            }
            return data;
        });

        const finalData = (filter === 'unread') ? messages.filter(m => m.isUnread) : messages;
        
        // Başarılı ekran görüntüsünü de alalım (Debug için iyi olur)
        const shot = await page.screenshot({ encoding: 'base64' });
        
        res.json({ 
            success: true, 
            count: finalData.length, 
            messages: finalData,
            debug_image: `<img src="data:image/png;base64,${shot}" />`
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// 4. CEVAP YAZ (SEND REPLY)
app.post('/send-reply', async (req, res) => {
    const { messageLink, replyText } = req.body;
    let browser;
    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Giriş yapılmamış" });
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await authProxy(page);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Sohbet detayına gidiliyor...');
        await page.goto(messageLink, { waitUntil: 'domcontentloaded', timeout: 120000 });
        
        const textareaSelector = 'textarea'; 
        await page.waitForSelector(textareaSelector, { timeout: 30000 });
        
        // Mesajı yaz
        await page.type(textareaSelector, replyText);
        
        console.log('Gönderiliyor...');
        await page.click('button[type="submit"]'); // Selector değişebilir, kontrol edilmeli
        
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});

        res.json({ success: true, message: "Cevap gönderildi." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// 5. MANUEL COOKIE YÜKLEME (Acil Durum İçin)
app.post('/inject-cookies', async (req, res) => {
    const { cookies } = req.body;
    if(cookies) {
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        res.json({ success: true, message: "Cookie kaydedildi." });
    } else {
        res.status(400).json({ error: "Cookie verisi yok." });
    }
});

app.listen(3000, () => console.log('Proxy V11 (Headless:False + UK Proxy) Hazır.'));
