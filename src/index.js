const { PuppeteerCrawler, Dataset, ProxyConfiguration } = require('crawlee');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet'); // Импортируем библиотеку
const { JWT } = require('google-auth-library'); // Импортируем JWT из google-auth-library
require('dotenv').config(); // Загружаем переменные из .env

// Создание экземпляра JWT для аутентификации
const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Обработка переносов строк
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Инициализация Google Spreadsheet без аутентификации
const doc = new GoogleSpreadsheet('19K9brUB9nE46Ty-NVa3O2h5p8M-roLKLnqASm7nqqmw'); // Замените на ваш ID таблицы

// Функция для авторизации и доступа к таблице
async function accessSpreadsheet() {
    try {
        await auth.authorize(); // Авторизация
        doc.authClient = auth; // Назначение auth клиента
        await doc.loadInfo(); // Загрузка информации о документе
        console.log(`Название таблицы: ${doc.title}`);

        const sheet = doc.sheetsByIndex[0]; // Первый лист
        return sheet;
    } catch (error) {
        console.error('Ошибка авторизации в Google Sheets:', error);
        process.exit(1);
    }
}

let proxyUrl = 'http://dx7rtz3bg2-corp-country-NL-hold-session-session-67181d788d22c:RwFdxeBi3IXFAAVR@93.190.142.57:9999';

// Создаём экземпляр ProxyConfiguration
const proxyConfiguration = new ProxyConfiguration({
    proxyUrls: [proxyUrl],
});

// Функция для обновления IP прокси
async function refreshProxy() {
    try {
        const apiKey = process.env.API_KEY;
        const response = await axios.get(`https://api.asocks.com/v2/proxy/refresh/65999495?apiKey=${apiKey}`);
        if (response.status === 200) {
            console.log('IP прокси успешно обновлен.');
            // Если после обновления прокси URL изменяется, обновите proxyUrl здесь
            // proxyUrl = обновленный_прокси_URL;

            // Обновляем proxyUrls в proxyConfiguration
            proxyConfiguration.proxyUrls = [proxyUrl];
            return true;
        }
    } catch (error) {
        console.error('Не удалось обновить IP прокси:', error.message);
        return false;
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

    const crawler = new PuppeteerCrawler({
        // Используем proxyConfiguration
        proxyConfiguration,
        launchContext: {
            launchOptions: {
                headless: true, // Используем headless режим для экономии ресурсов
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Дополнительные флаги для стабильности
                ],
            },
        },
        maxConcurrency: 1, // Устанавливаем последовательный парсинг (1 поток)
        async requestHandler({ page, request, log, proxyInfo }) {
            log.info(`Обработка ${request.url} с использованием прокси ${proxyInfo.url}...`);

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
                        // Корректируем селектор для изображения
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
                    log.warn(`Пост: ${profileName}, mediaUrl отсутствует.`);
                }
            });

            const dataToSave = {
                profile: profileName,
                parsingDate: new Date().toISOString(),
                posts: filteredPostsData,
                trafficMB: (totalBytes / (1024 * 1024)).toFixed(2), // Добавляем потребленный трафик в MB
            };

            // Запись данных в Google Sheets
            const row = {
                Profile: dataToSave.profile,
                ParsingDate: dataToSave.parsingDate,
                TrafficMB: dataToSave.trafficMB,
            };

            // Динамическое добавление постов
            dataToSave.posts.forEach((post, index) => {
                row[`Post${index + 1}_Date`] = post.date;
                row[`Post${index + 1}_Text`] = post.text;
                row[`Post${index + 1}_MediaUrl`] = post.mediaUrl;
                row[`Post${index + 1}_Comments`] = post.comments;
                row[`Post${index + 1}_Shares`] = post.shares;
                row[`Post${index + 1}_Likes`] = post.likes;
            });

            sheet.addRow(row).catch(error => {
                log.error(`Ошибка при добавлении строки в Google Sheets: ${error.message}`);
            });

            // Также сохраняем данные в Crawlee Dataset
            await Dataset.pushData(dataToSave);

            log.info(`Найдено ${filteredPostsData.length} постов для профиля ${profileName}`);
            log.info(`Потреблено трафика: ${dataToSave.trafficMB} MB для профиля ${profileName}`);
            await page.close();

            // Задержка перед следующим запросом
            await new Promise(resolve => setTimeout(resolve, 5000)); // Задержка 5 секунд
        },
        failedRequestHandler: async ({ request, log }) => {
            log.error(`Запрос ${request.url} завершился неудачей. Пытаемся обновить IP прокси...`);

            // Обновление IP прокси
            if (await refreshProxy()) {
                log.info('Прокси успешно обновлен. Продолжаем парсинг...');
                // Обновляем proxyUrls в proxyConfiguration
                proxyConfiguration.proxyUrls = [proxyUrl];
            } else {
                log.error('Не удалось обновить прокси. Завершаем выполнение.');
                process.exit(1); // Завершаем выполнение скрипта при неудаче
            }
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
