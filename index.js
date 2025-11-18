const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '10mb' }));

const TIMEOUT = 60000;

app.post('/get-messages', async (req, res) => {
    const { username, password, cookies } = req.body;
    let browser;

    try {
        console.log('Bot (V4 - Scraper) başlatılıyor...');
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080'],
            executablePath: '/usr/bin/google-chrome'
        });

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(TIMEOUT);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        if (cookies && Array.isArray(cookies)) {
            await page.setCookie(...cookies);
            console.log('Cookie yüklendi.');
        }

        console.log('Mesajlar sayfasına gidiliyor...');
        await page.goto('https://banaozel.sahibinden.com/mesajlarim', { waitUntil: 'domcontentloaded' });

        if (page.url().includes('giris')) {
            console.log('Oturum düşmüş, tekrar giriş yapılıyor...');
            if (!username || !password) throw new Error("Oturum kapalı ve şifre yok.");
            await page.type('#username', username, { delay: 50 });
            await page.type('#password', password, { delay: 50 });
            await Promise.all([
                page.click('#userLoginSubmitButton'),
                page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            ]);
        }

        await page.waitForSelector('body');

        console.log('Sayfa taraniyor...');
        const data = await page.evaluate(() => {
            const messages = [];
            // Tablo yapısını kontrol et
            const rows = document.querySelectorAll('table tbody tr');
            
            if (rows.length > 0) {
                rows.forEach(row => {
                    const text = row.innerText.replace(/\n/g, ' | '); // Satırları birleştir
                    if(text.length > 5) {
                         messages.push({ raw: text });
                    }
                });
            } else {
                // Liste yapısını kontrol et
                const items = document.querySelectorAll('li'); 
                items.forEach(item => {
                    if (item.innerText.includes('sahibinden.com') || item.innerText.length > 20) {
                         messages.push({ text: item.innerText.replace(/\n/g, ' | ') });
                    }
                });
            }
            return messages;
        });

        console.log(`${data.length} mesaj bulundu.`);
        const title = await page.title();

        res.json({ 
            success: true, 
            pageTitle: title,
            count: data.length,
            messages: data 
        });

    } catch (error) {
        console.error('Hata:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(3000, () => console.log('Proxy V4 (Data Scraper) hazır.'));
