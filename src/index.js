const { PuppeteerCrawler, Dataset } = require('crawlee');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

// Логи для проверки переменных окружения
console.log('Service Account Email:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
console.log('Private Key:', process.env.GOOGLE_PRIVATE_KEY ? 'Loaded' : 'Not Loaded');

// Создание экземпляра JWT для аутентификации
const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Инициализация Google Spreadsheet с передачей auth
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);

// Функция для доступа к таблице
async function accessSpreadsheet() {
    try {
        await doc.loadInfo(); // Загрузка информации о документе
        console.log(`Название таблицы: ${doc.title}`);

        const sheet = doc.sheetsByIndex[0]; // Первый лист
        return sheet;
    } catch (error) {
        console.error('Ошибка при доступе к Google Sheets:', error);
        process.exit(1);
    }
}

(async () => {
    const urlsToParse = [
        'https://x.com/dagorenouf',
        'https://x.com/silenthill',
        // Дополнительные URL могут быть добавлены сюда
    ];

    // Получаем лист для записи данных
    const sheet = await accessSpreadsheet();

    // Загружаем заголовки (если необходимо)
    try {
        await sheet.loadHeaderRow();
    } catch (error) {
        console.error('Ошибка при загрузке заголовков:', error.message);
    }

    const crawler = new PuppeteerCrawler({
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                ],
            },
        },
        maxConcurrency: 1,
        maxRequestRetries: 0, // Устанавливаем количество повторных попыток в 0
        async requestHandler({ page, request, log }) {
            log.info(`Обработка ${request.url}...`);

            const profileName = request.url.split('/').pop();
            let loadedPostsCount = 0;
            const requiredPosts = 5;
            let retries = 0;
            const maxRetries = 3;

            // Переменная для отслеживания потребленного трафика
            let totalBytes = 0;

            // Настройка мобильного режима
            const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) ' +
                'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15A372 Safari/604.1';
            await page.setUserAgent(mobileUserAgent);
            await page.setViewport({
                width: 375,
                height: 667,
                isMobile: true,
                hasTouch: true,
            });

            // Включаем перехват запросов
            await page.setRequestInterception(true);

            // Минимальный прозрачный пиксель (1x1 PNG)
            const transparentPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NkYGBgAAAABQABDQottAAAAABJRU5ErkJggg==';

            // Обработка запросов для блокировки ненужных ресурсов и доменов
            const blockedDomains = ['example.com', 'anotherdomain.com']; // Добавьте необходимые домены
            page.on('request', (req) => {
                const url = req.url();
                const resourceType = req.resourceType();

                if (blockedDomains.some(domain => url.includes(domain))) {
                    req.abort();
                    return;
                }

                if (['stylesheet', 'font', 'media'].includes(resourceType)) {
                    req.abort();
                    return;
                }

                if (resourceType === 'image') {
                    // Отвечаем с минимальным прозрачным изображением для экономии трафика
                    req.respond({
                        status: 200,
                        contentType: 'image/png',
                        body: Buffer.from(transparentPixel.split(',')[1], 'base64'),
                    });
                    return;
                }

                req.continue();
            });

            // Обработка ответов для подсчета потребленного трафика
            page.on('response', async (response) => {
                try {
                    const headers = response.headers();
                    let length = 0;
                    if (headers['content-length']) {
                        length = parseInt(headers['content-length'], 10);
                    } else {
                        // Если content-length отсутствует, нужно получить размер буфера
                        const buffer = await response.buffer();
                        length = buffer.length;
                    }
                    totalBytes += length;
                } catch (err) {
                    // Некоторые ответы могут не иметь тела (например, 204 No Content)
                }
            });

            while (loadedPostsCount < requiredPosts && retries < maxRetries) {
                await page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight);
                });

                await new Promise(resolve => setTimeout(resolve, 10000)); // Увеличенное время ожидания

                const posts = await page.$$eval('div[data-testid="cellInnerDiv"]', divs => divs.length);

                if (posts > loadedPostsCount) {
                    loadedPostsCount = posts;
                    retries = 0;
                    log.info(`Загружено ${loadedPostsCount} постов...`);
                } else {
                    retries += 1;
                    log.info('Новых постов не найдено, пробуем снова...');
                }
            }

            const postsData = await page.$$eval(
                'div[data-testid="cellInnerDiv"]',
                (divs, requiredPosts) => {
                    return divs.slice(0, requiredPosts).map(div => {
                        const dateElement = div.querySelector('time');
                        const date = dateElement ? dateElement.getAttribute('datetime') : null;

                        const textElement = div.querySelector('[data-testid="tweetText"]');
                        const text = textElement ? textElement.innerText : null;

                        let mediaUrl = null;
                        const imageElement = div.querySelector('img[data-testid="tweetPhoto"]') || div.querySelector('img[src*="media"]');
                        const videoElement = div.querySelector('video source');

                        if (videoElement && videoElement.src) {
                            mediaUrl = videoElement.src;
                        } else if (imageElement && imageElement.src && imageElement.src !== 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NkYGBgAAAABQABDQottAAAAABJRU5ErkJggg==') {
                            mediaUrl = imageElement.src;
                        }

                        const comments = div.querySelector('button[data-testid="reply"] span')?.textContent || '0';
                        const shares = div.querySelector('button[data-testid="retweet"] span')?.textContent || '0';
                        const likes = div.querySelector('button[data-testid="like"] span')?.textContent || '0';

                        return {
                            date,
                            text,
                            mediaUrl,
                            comments,
                            shares,
                            likes,
                        };
                    });
                },
                requiredPosts
            );

            // Фильтрация пустых mediaUrl
            const filteredPostsData = postsData.map(post => {
                if (post.mediaUrl && !post.mediaUrl.startsWith('data:image')) {
                    return post;
                }
                return { ...post, mediaUrl: null };
            });

            // Логирование извлеченных mediaUrl для отладки (опционально)
            filteredPostsData.forEach(post => {
                if (post.mediaUrl) {
                    log.info(`Пост: ${profileName}, mediaUrl: ${post.mediaUrl}`);
                } else {
                    log.warning(`Пост: ${profileName}, mediaUrl отсутствует.`);
                }
            });

            const dataToSave = {
                profile: profileName,
                parsingDate: new Date().toISOString(),
                posts: filteredPostsData,
                trafficMB: (totalBytes / (1024 * 1024)).toFixed(2), // Добавляем потребленный трафик в MB
            };

            // Запись данных в Google Sheets
            try {
                for (const post of dataToSave.posts) {
                    const row = {
                        ParsDate: new Date().toISOString(),
                        Profile: dataToSave.profile,
                        ParsingDate: dataToSave.parsingDate,
                        TrafficMB: dataToSave.trafficMB,
                        PostDate: post.date,
                        PostText: post.text,
                        MediaUrl: post.mediaUrl,
                        Comments: post.comments,
                        Shares: post.shares,
                        Likes: post.likes,
                    };
                    await sheet.addRow(row);
                }
                log.info(`Данные успешно добавлены в Google Sheets для профиля ${profileName}`);
            } catch (error) {
                log.error(`Ошибка при добавлении строки в Google Sheets: ${error.message}`);
            }

            // Также сохраняем данные в Crawlee Dataset
            await Dataset.pushData(dataToSave);

            log.info(`Найдено ${filteredPostsData.length} постов для профиля ${profileName}`);
            log.info(`Потреблено трафика: ${dataToSave.trafficMB} MB для профиля ${profileName}`);
            await page.close();

            // Задержка перед следующим запросом
            await new Promise(resolve => setTimeout(resolve, 5000)); // Задержка 5 секунд
        },
    });

    await crawler.run(urlsToParse);

    async function exportDataToJson() {
        const items = await Dataset.getData();
        const data = items.items;

        const outputDir = path.join(__dirname, 'output');
        const filePath = path.join(outputDir, 'output.json');

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log('Данные успешно экспортированы в', filePath);
    }

    await exportDataToJson();
})();
