const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json({ limit: '10mb' }));

// --- AYARLAR ---
const COOKIE_PATH = './cookies.json'; // Cookie'leri burada saklayacağız
let globalBrowser = null; // SMS sürecinde tarayıcıyı açık tutmak için
let globalPage = null;

// Tarayıcı Başlatma Fonksiyonu
async function startBrowser() {
    return await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080'],
        executablePath: '/usr/bin/google-chrome'
    });
}

// 1. GİRİŞ YAPMA MODÜLÜ (Otomatik & SMS Kontrollü)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        if (globalBrowser) await globalBrowser.close(); // Varsa eskisi kapat
        globalBrowser = await startBrowser();
        globalPage = await globalBrowser.newPage();
        
        await globalPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        console.log('Giriş sayfasına gidiliyor...');
        await globalPage.goto('https://secure.sahibinden.com/giris', { waitUntil: 'networkidle2' });

        console.log('Bilgiler giriliyor...');
        await globalPage.type('#username', username, { delay: 100 });
        await globalPage.type('#password', password, { delay: 100 });
        
        await Promise.all([
            globalPage.click('#userLoginSubmitButton'),
            globalPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        ]);

        // SMS Kontrolü
        const content = await globalPage.content();
        if (content.includes("Doğrulama Kodu") || content.includes("verification code")) {
            console.log('SMS Doğrulaması istendi! Tarayıcı açık bekletiliyor.');
            return res.json({ status: "sms_required", message: "Lütfen /submit-sms endpointine kodu gönderin." });
        }

        // SMS istemediyse Cookie kaydet ve kapat
        const cookies = await globalPage.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        console.log('Giriş başarılı, cookie kaydedildi.');
        
        await globalBrowser.close();
        globalBrowser = null;
        res.json({ status: "success", message: "Giriş başarılı, oturum kaydedildi." });

    } catch (error) {
        console.error(error);
        if(globalBrowser) await globalBrowser.close();
        res.status(500).json({ status: "error", error: error.message });
    }
});

// 2. SMS KODU GİRME MODÜLÜ
app.post('/submit-sms', async (req, res) => {
    const { code } = req.body;
    
    if (!globalPage || !globalBrowser) {
        return res.status(400).json({ status: "error", message: "Aktif bir giriş oturumu yok. Önce /login yapın." });
    }

    try {
        console.log(`SMS Kodu giriliyor: ${code}`);
        // SMS input alanı (Selector değişebilir, kontrol edilmeli)
        await globalPage.type('#code', code, { delay: 100 }); // id='code' tahmini, kontrol et
        
        await Promise.all([
            // Buton ID'si veya class'ı bulunmalı, genelde type="submit" olur
            globalPage.click('button[type="submit"]'), 
            globalPage.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);

        const cookies = await globalPage.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        console.log('SMS onaylandı, cookie kaydedildi.');

        await globalBrowser.close();
        globalBrowser = null;
        res.json({ status: "success", message: "Oturum açıldı ve kaydedildi." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", error: error.message });
    }
});

// 3. MESAJLARI OKUMA MODÜLÜ (Filtreli)
app.post('/get-messages', async (req, res) => {
    const { filter } = req.body; // 'all' veya 'unread'
    let browser;

    try {
        // Kayıtlı cookie var mı?
        if (!fs.existsSync(COOKIE_PATH)) {
            return res.status(401).json({ status: "error", message: "Cookie yok! Önce /login yapın." });
        }
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));

        browser = await startBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        await page.setCookie(...cookies);

        console.log('Mesajlara gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('body');

        // Veri Çekme
        const messages = await page.evaluate((filterType) => {
            const data = [];
            // Mesaj satırlarını bul (Doğru selectorlar önemli)
            // Genelde: tr.unread (okunmamış) gibi sınıflar olur
            const rows = document.querySelectorAll('table tbody tr');

            rows.forEach(row => {
                const isUnread = row.classList.contains('unread') || row.style.fontWeight === 'bold'; // Tahmini kontrol
                const linkElement = row.querySelector('a'); // Mesaj linki
                const link = linkElement ? linkElement.href : null;
                const text = row.innerText.replace(/\n/g, ' | ').trim();

                const msgObj = {
                    raw: text,
                    link: link, // Cevap yazmak için bu linke gitmemiz gerekecek
                    isUnread: isUnread
                };

                if (filterType === 'unread') {
                    if (isUnread) data.push(msgObj);
                } else {
                    data.push(msgObj);
                }
            });
            return data;
        }, filter);

        console.log(`${messages.length} mesaj çekildi.`);
        res.json({ success: true, messages: messages });

    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// 4. CEVAP YAZMA MODÜLÜ
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

        console.log('Sohbet sayfasına gidiliyor...');
        await page.goto(messageLink, { waitUntil: 'domcontentloaded' });

        // Mesaj kutusunu bul ve yaz (Selector değişebilir!)
        // Genelde textarea veya input[type=text]
        await page.waitForSelector('textarea'); // Tahmini
        await page.type('textarea', replyText);
        
        console.log('Gönderiliyor...');
        // Gönder butonu
        await page.click('button#send'); // Tahmini ID
        await page.waitForNavigation({ waitUntil: 'networkidle0' }); // Gönderimin bitmesini bekle

        res.json({ success: true, message: "Cevap gönderildi." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(3000, () => console.log('Proxy V6 (Tam Otomatik) Hazır.'));
