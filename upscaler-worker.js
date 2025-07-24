/* 
 =========================================================================
 == upscaler-worker.js (最终决定版 V8 - Flex Delegate 修正版)
 =========================================================================
*/

console.log('[WORKER] 最终决定版 V8 脚本启动 (Flex Delegate 修正版)');

// 步骤 1: 导入所有必要的库
self.importScripts(
    './libs/tf.min.js',
    './libs/tf-backend-wasm.min.js',
    './libs/tf-tflite.min.js'
);

// 全局模型缓存
let modelCache = {};

// --- 主要消息处理 ---
self.onmessage = async (event) => {
    const { type, imageData, config } = event.data;
    if (type === 'start') {
        try {
            console.log('[WORKER] 收到开始处理指令...');
            await initializeTFLite();
            console.log('[WORKER] TFLite 初始化完毕，准备放大图像。');
            const result = await upscaleImage(imageData, config);
            self.postMessage({ type: 'done', payload: { imageData: result } });
        } catch (error) {
            console.error('[WORKER] 任务执行期间发生致命错误:', error);
            self.postMessage({ type: 'error', payload: { message: error.message, stack: error.stack } });
        }
    }
};

// --- 初始化函数 (保持 V7 版本) ---
async function initializeTFLite() {
    console.log('[WORKER] 进入 initializeTFLite 函数...');
    try {
        console.log('[WORKER] 准备设置 TF.js WASM 后端。');
        
        tflite.setWasmPath('./wasm/');

        await tf.setBackend('wasm');
        await tf.ready();
        console.log('[WORKER] TF.js WASM 后端准备就绪。');
        
        if (typeof tflite === 'undefined' || typeof tflite.loadTFLiteModel !== 'function') {
            throw new Error('TFLite API (tflite.loadTFLiteModel) 未在全局作用域中找到。请检查 tf-tflite.min.js 是否已正确导入。');
        }
        
    } catch (e) {
        console.error('[WORKER] 初始化 TFLite 模块时失败！', e);
        throw new Error(`无法初始化 TFLite 模块: ${e.message}`);
    }
    console.log('[WORKER] TFLite 模块初始化成功完成！');
}

// --- 模型加载函数 (已修正，加入 Flex Delegate 和加载进度) ---
async function loadModel(modelPath) {
    if (modelCache[modelPath]) {
        console.log(`[WORKER] 从缓存中获取模型: ${modelPath}`);
        return modelCache[modelPath];
    }
    
    console.log(`[WORKER] 正在加载模型: ${modelPath}`);
    
    // **关键修正 1**: 我们自己 fetch 模型以便获取加载进度
    const response = await fetch(modelPath);
    if (!response.ok) {
        throw new Error(`模型加载失败: ${modelPath} (状态码: ${response.status} ${response.statusText})`);
    }
    
    const contentLength = +response.headers.get('Content-Length');
    let loaded = 0;
    const stream = new ReadableStream({
        start(controller) {
            const reader = response.body.getReader();
            function read() {
                reader.read().then(({ done, value }) => {
                    if (done) {
                        controller.close();
                        return;
                    }
                    loaded += value.byteLength;
                    if (contentLength) {
                        self.postMessage({ type: 'model-loading', payload: { file: modelPath.split('/').pop(), progress: loaded / contentLength } });
                    }
                    controller.enqueue(value);
                    read();
                }).catch(error => {
                    console.error(`[WORKER] 读取模型流时出错: ${modelPath}`, error);
                    controller.error(error);
                });
            }
            read();
        }
    });

    const modelBuffer = await new Response(stream).arrayBuffer();
    console.log(`[WORKER] 模型文件下载完毕，大小: ${(modelBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // **关键修正 2**: 创建包含 Flex Op Resolver 的选项对象
    const options = {
        opResolver: new tflite.ops.TFLiteFlexOpResolver()
    };

    // **关键修正 3**: 将加载好的 ArrayBuffer 和选项传递给 loadTFLiteModel
    const model = await tflite.loadTFLiteModel(modelBuffer, options);
    
    modelCache[modelPath] = model;
    console.log(`[WORKER] 模型加载并初始化完毕: ${modelPath}`);
    return model;
}


// --- 图像放大主流程 (保持 V7 版本) ---
async function upscaleImage(imageData, config) {
    const inputTensor = tf.tidy(() => {
        return tf.tensor(imageData.data, [imageData.height, imageData.width, 4], 'int32')
                 .slice([0, 0, 0], [imageData.height, imageData.width, 3])
                 .toFloat()
                 .div(255.0);
    });

    const tasks = getWaifu2xTasks(config);
    let currentTensor = inputTensor;

    for (const task of tasks) {
        const model = await loadModel(task.modelPath);
        const processedTensor = await processWithModel(currentTensor, model, config.patchSize, task.scale);
        if (currentTensor !== inputTensor) {
            currentTensor.dispose();
        }
        currentTensor = processedTensor;
    }

    const outputImageData = await convertTensorToImageData(currentTensor);
    currentTensor.dispose();
    return outputImageData;
}

// --- 分块处理函数 (保持 V7 版本) ---
async function processWithModel(inputTensor, model, patchSize, scale) {
    const [height, width] = inputTensor.shape;
    const outputShape = [height * scale, width * scale, 3];
    const outputBuffer = tf.buffer(outputShape, 'float32');
    
    const tilesX = Math.ceil(width / patchSize);
    const tilesY = Math.ceil(height / patchSize);
    const totalTiles = tilesX * tilesY;
    let processedTiles = 0;
    let avgTimePerTile = 0;

    for (let y = 0; y < tilesY; y++) {
        for (let x = 0; x < tilesX; x++) {
            const tileStartTime = performance.now();
            
            const resultPatch = tf.tidy(() => {
                const yStart = y * patchSize;
                const xStart = x * patchSize;
                const patch = inputTensor.slice(
                    [yStart, xStart, 0], 
                    [Math.min(height - yStart, patchSize), Math.min(width - xStart, patchSize), 3]
                );
                const expandedPatch = patch.expandDims(0);
                
                const outputTensor = model.predict(expandedPatch);
                return outputTensor.squeeze([0]);
            });

            const [patchHeight, patchWidth] = resultPatch.shape;
            const resultData = await resultPatch.data();
            resultPatch.dispose();
            
            const yOffset = y * patchSize * scale;
            const xOffset = x * patchSize * scale;
            
            for (let i = 0; i < patchHeight; i++) {
                for (let j = 0; j < patchWidth; j++) {
                    const idx = (i * patchWidth + j) * 3;
                    outputBuffer.set(resultData[idx], yOffset + i, xOffset + j, 0);
                    outputBuffer.set(resultData[idx + 1], yOffset + i, xOffset + j, 1);
                    outputBuffer.set(resultData[idx + 2], yOffset + i, xOffset + j, 2);
                }
            }

            processedTiles++;
            const tileTime = performance.now() - tileStartTime;
            avgTimePerTile = (avgTimePerTile * (processedTiles - 1) + tileTime) / processedTiles;
            const eta = ((totalTiles - processedTiles) * avgTimePerTile) / 1000;
            self.postMessage({ type: 'progress', payload: { progress: processedTiles / totalTiles, eta } });
        }
    }
    
    return outputBuffer.toTensor();
}


// --- 辅助函数 (保持不变) ---
async function convertTensorToImageData(tensor) {
    const [height, width] = tensor.shape;
    const finalTensor = tensor.clipByValue(0, 1).mul(255).cast('int32');
    const data = await finalTensor.data();
    finalTensor.dispose();
    const outputImageData = new ImageData(width, height);
    let j = 0;
    for (let i = 0; i < data.length; i += 3) {
        outputImageData.data[j++] = data[i];
        outputImageData.data[j++] = data[i + 1];
        outputImageData.data[j++] = data[i + 2];
        outputImageData.data[j++] = 255;
    }
    return outputImageData;
}

function getWaifu2xTasks(config) {
    const { arch, style, noise, scale } = config.waifu2x;
    const basePath = `./models/waifu2x/${arch}/${style}/`;
    let tasks = [];
    if (arch === 'swin_unet') {
        if (noise !== '0') {
            tasks.push({ modelPath: `${basePath}noise${noise}.tflite`, scale: 1 });
        }
        if (scale > 1) {
             tasks.push({ modelPath: `${basePath}scale${scale}x.tflite`, scale: scale });
        }
    } else { 
        let modelName;
        if (noise === '0') {
            modelName = `scale2x.tflite`; 
        } else {
            modelName = `noise${noise}_scale2x.tflite`;
        }
        tasks.push({ modelPath: basePath + modelName, scale: 2 });
    }
    return tasks;
}