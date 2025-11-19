const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '50mb' })); // Ekran görüntüsü için limit artırıldı

const COOKIE_PATH = './cookies.json';
let globalBrowser = null;
let globalPage = null;

// Tarayıcı Başlatıcı
async function startBrowser() {
    return await puppeteer.launch({
        headless: "new",
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

// 1. GİRİŞ YAPMA (Login)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        // Önceki açık tarayıcı varsa kapat
        if (globalBrowser) await globalBrowser.close();
        
        console.log('Tarayıcı başlatılıyor...');
        globalBrowser = await startBrowser();
        globalPage = await globalBrowser.newPage();
        
        // Bot izlerini gizle
        await globalPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        // Timeout'u 60 saniye yapalım
        await globalPage.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Cloudflare kontrolü için 5 saniye bekleniyor...');
        await new Promise(r => setTimeout(r, 5000));

        console.log('Kullanıcı bilgileri giriliyor...');
        // Username alanını bekle
        await globalPage.waitForSelector('#username', { visible: true, timeout: 15000 });

        await globalPage.type('#username', username, { delay: 150 });
        await globalPage.type('#password', password, { delay: 150 });
        
        await Promise.all([
            globalPage.click('#userLoginSubmitButton'),
            globalPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        ]);

        // SMS Kontrolü
        const content = await globalPage.content();
        if (content.includes("Doğrulama Kodu") || content.includes("verification code") || content.includes("sms-verification")) {
            console.log('SMS Doğrulaması İsteniyor!');
            
            // Ekran görüntüsü alıp n8n'e gönderelim ki emin olalım
            const screenshot = await globalPage.screenshot({ encoding: 'base64' });
            
            return res.json({ 
                status: "sms_required", 
                message: "Lütfen /submit-sms adresine kodu gönderin.",
                debug_image: `<img src="data:image/png;base64,${screenshot}" />`
            });
        }

        // Başarılı ise cookie kaydet
        const cookies = await globalPage.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        console.log('Giriş başarılı, cookie kaydedildi.');
        
        await globalBrowser.close();
        globalBrowser = null;
        
        res.json({ status: "success", message: "Giriş başarılı." });

    } catch (error) {
        console.error("Hata:", error.message);
        let errorShot = "";
        try {
             if(globalPage) errorShot = await globalPage.screenshot({ encoding: 'base64' });
        } catch(e) {}

        // Hata olsa bile tarayıcıyı kapat
        if(globalBrowser) {
            await globalBrowser.close();
            globalBrowser = null;
        }

        res.status(500).json({ 
            status: "error", 
            error: error.message,
            debug_image: `<img src="data:image/png;base64,${errorShot}" />` 
        });
    }
});

// 2. SMS GİRME (Submit SMS)
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    
    // Dikkat: Bu fonksiyonun çalışması için /login'in tarayıcıyı kapatmamış olması gerekir.
    // Ancak sunucusuz mimaride (Stateless) bu zordur.
    // Bu yüzden basitlik adına; SMS gelince manuel giriş yapıp cookie'yi elle almayı veya
    // Tarayıcıyı global değişkende tutmayı deniyoruz (yukarıda globalBrowser var).
    
    if (!globalBrowser || !globalPage) {
        return res.status(400).json({ status: "error", message: "Aktif bir giriş oturumu yok. Lütfen tekrar /login isteği atın." });
    }

    try {
        console.log(`SMS Kodu giriliyor: ${code}`);
        // Input alanını bul (Genelde id='code' olur ama değişebilir, genel input arıyoruz)
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
        
        res.json({ status: "success", message: "SMS onaylandı ve cookie kaydedildi." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", error: error.message });
    }
});

// 3. MESAJLARI OKUMA (Scraper)
app.post('/get-messages', async (req, res) => {
    const { filter } = req.body; // 'unread' veya 'all'
    let browser;

    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Cookie yok! Önce /login yapın." });
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded' });

        // Oturum düşmüş mü?
        if (page.url().includes('giris')) {
             return res.status(401).json({ status: "session_expired", message: "Oturum süresi dolmuş, tekrar /login yapın." });
        }

        await new Promise(r => setTimeout(r, 3000)); // Yükleme beklemesi

        const messages = await page.evaluate(() => {
            const data = [];
            const rows = document.querySelectorAll('tbody tr'); // Tablo satırları
            
            if (rows.length > 0) {
                rows.forEach(row => {
                    // Okunmamış mesaj kontrolü (class='unread' veya font-weight bold)
                    // Sahibinden yapısına göre: genellikle 'unread' classı olur.
                    const isUnread = row.classList.contains('unread') || row.querySelector('strong') !== null;
                    
                    const text = row.innerText.replace(/\n/g, ' | ').trim();
                    
                    // Linki al (Cevap yazmak için lazım olacak)
                    const linkEl = row.querySelector('a');
                    const link = linkEl ? linkEl.href : null;

                    data.push({ 
                        raw: text, 
                        isUnread: isUnread,
                        link: link
                    });
                });
            }
            return data;
        });

        // Filtreleme
        const finalData = (filter === 'unread') ? messages.filter(m => m.isUnread) : messages;

        res.json({ success: true, count: finalData.length, messages: finalData });

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// 4. CEVAP YAZMA (Reply)
app.post('/send-reply', async (req, res) => {
    const { messageLink, replyText } = req.body;
    let browser;

    try {
        if (!fs.existsSync(COOKIE_PATH)) return res.status(401).json({ error: "Giriş yapılmamış" });
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Sohbet detayına gidiliyor...');
        await page.goto(messageLink, { waitUntil: 'domcontentloaded' });
        
        await new Promise(r => setTimeout(r, 3000));

        // Mesaj kutusu (Textarea)
        const textareaSelector = 'textarea'; 
        await page.waitForSelector(textareaSelector);
        
        await page.type(textareaSelector, replyText);
        
        console.log('Gönderiliyor...');
        // Gönder butonu (Genelde id="send" veya class="btn-send")
        // Garantilemek için "Gönder" yazan butonu arayalım veya genel buton
        await page.click('button[type="submit"]'); 
        
        await new Promise(r => setTimeout(r, 3000)); // Gönderim beklemesi

        res.json({ success: true, message: "Cevap gönderildi." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(3000, () => console.log('Proxy V6.1 (Coolify Edition) Hazır.'));
