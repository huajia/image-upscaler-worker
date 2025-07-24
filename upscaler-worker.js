/* 
 =========================================================================
 == upscaler-worker.js (ONNX.js 最终版 - 路径已验证)
 =========================================================================
*/
console.log('[WORKER] ONNX.js Worker 脚本启动');

// 导入 ONNX.js 运行时
self.importScripts("./libs/ort.min.js");

// 设置WASM文件所在的目录路径"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";

let modelCache = {};

// --- 主要消息处理 ---
self.onmessage = async (event) => {
    const { type, file, config } = event.data;
    if (type === 'start') {
        try {
            self.postMessage({ type: 'status', payload: { message: '正在从图片文件解码...' } });
            const imageData = await createImageDataFromFile(file);

            self.postMessage({ type: 'status', payload: { message: '图片解码完成，开始放大流程...' } });
            const resultImageData = await upscaleImage(imageData, config);
            
            // 将结果（包含可转移对象ArrayBuffer）发送回主线程
            self.postMessage({ type: 'done', payload: { data: resultImageData.data.buffer, width: resultImageData.width, height: resultImageData.height } }, [resultImageData.data.buffer]);
        } catch (error) {
            console.error('[WORKER] 任务执行期间发生错误:', error);
            self.postMessage({ type: 'error', payload: { message: error.message, stack: error.stack } });
        }
    }
};

// --- 文件到ImageData转换 ---
async function createImageDataFromFile(file) {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, width, height);
}


// --- 模型加载函数 ---
async function loadModel(modelPath) {
    if (modelCache[modelPath]) {
        console.log(`[WORKER] 从缓存中获取模型: ${modelPath}`);
        return modelCache[modelPath];
    }
    
    self.postMessage({ type: 'status', payload: { message: `正在加载模型: ${modelPath.split('/').pop()}` } });
    console.log(`[WORKER] 正在加载模型: ${modelPath}`);
    
    const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
    });
    
    modelCache[modelPath] = session;
    console.log(`[WORKER] 模型加载并初始化完毕: ${modelPath}`);
    return session;
}


// --- 图像放大主流程 ---
async function upscaleImage(imageData, config) {
    let currentTensorData = imageDataToFloat32(imageData);
    let currentWidth = imageData.width;
    let currentHeight = imageData.height;

    const tasks = getWaifu2xTasks(config);
    if (tasks.length === 0) { // 如果没有任务，直接返回原图
         self.postMessage({ type: 'status', payload: { message: '无需处理，返回原图。' } });
         return imageData;
    }

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskName = `${i + 1}/${tasks.length} (${task.modelPath.split('/').pop()})`;
        
        const model = await loadModel(task.modelPath);
        
        const { outputData, outputWidth, outputHeight } = await processWithModel(
            currentTensorData, currentWidth, currentHeight,
            model,
            config.patchSize,
            task.scale,
            taskName
        );
        
        currentTensorData = outputData;
        currentWidth = outputWidth;
        currentHeight = outputHeight;
    }

    return float32ToImageData(currentTensorData, currentWidth, currentHeight);
}


// --- ONNX分块处理核心函数 ---
async function processWithModel(inputData, width, height, model, patchSize, scale, taskName) {
    const outputWidth = width * scale;
    const outputHeight = height * scale;
    const outputData = new Float32Array(3 * outputWidth * outputHeight);
    
    const tilesX = Math.ceil(width / patchSize);
    const tilesY = Math.ceil(height / patchSize);
    const totalTiles = tilesX * tilesY;
    let processedTiles = 0;
    let startTime = performance.now();

    for (let y = 0; y < tilesY; y++) {
        for (let x = 0; x < tilesX; x++) {
            const xStart = x * patchSize;
            const yStart = y * patchSize;
            const tileW = Math.min(patchSize, width - xStart);
            const tileH = Math.min(patchSize, height - yStart);

            const patchData = extractPatch(inputData, width, height, xStart, yStart, tileW, tileH);
            const inputTensor = new ort.Tensor('float32', patchData, [1, 3, tileH, tileW]);
            
            const feeds = { [model.inputNames[0]]: inputTensor };
            const results = await model.run(feeds);
            const outputPatchTensor = results[model.outputNames[0]];

            composePatch(outputData, outputWidth, outputHeight, xStart * scale, yStart * scale, outputPatchTensor.data, tileW * scale, tileH * scale);

            processedTiles++;
            const progress = processedTiles / totalTiles;
            const elapsed = (performance.now() - startTime) / 1000;
            const eta = progress > 0.01 ? (elapsed / progress) * (1 - progress) : 0;
            self.postMessage({ type: 'progress', payload: { progress, eta, task: taskName } });
        }
    }
    
    return { outputData, outputWidth, outputHeight };
}


// --- 数据转换与分块辅助函数 ---

function imageDataToFloat32(imageData) {
    const { data, width, height } = imageData;
    const float32Data = new Float32Array(3 * width * height);
    const planeSize = width * height;
    for (let i = 0; i < planeSize; i++) {
        const j = i * 4;
        float32Data[i] = data[j] / 255.0;           // R
        float32Data[i + planeSize] = data[j + 1] / 255.0; // G
        float32Data[i + 2 * planeSize] = data[j + 2] / 255.0; // B
    }
    return float32Data;
}

function float32ToImageData(float32Data, width, height) {
    const count = width * height;
    const planeSize = count;
    const imageData = new ImageData(width, height);
    const data = imageData.data;
    
    for (let i = 0; i < count; i++) {
        const i4 = i * 4;
        const r = float32Data[i];
        const g = float32Data[i + planeSize];
        const b = float32Data[i + 2 * planeSize];
        data[i4] = Math.max(0, Math.min(255, r * 255));
        data[i4 + 1] = Math.max(0, Math.min(255, g * 255));
        data[i4 + 2] = Math.max(0, Math.min(255, b * 255));
        data[i4 + 3] = 255;
    }
    return imageData;
}


function extractPatch(source, sourceW, sourceH, x, y, w, h) {
    const patch = new Float32Array(3 * w * h);
    const sourcePlaneSize = sourceW * sourceH;
    const patchPlaneSize = w * h;
    
    for (let c = 0; c < 3; c++) {
        const sourceOffset = c * sourcePlaneSize;
        const patchOffset = c * patchPlaneSize;
        for (let py = 0; py < h; py++) {
            const sourceRowStart = sourceOffset + (y + py) * sourceW;
            const patchRowStart = patchOffset + py * w;
            const sourceSlice = source.subarray(sourceRowStart + x, sourceRowStart + x + w);
            patch.set(sourceSlice, patchRowStart);
        }
    }
    return patch;
}

function composePatch(target, targetW, targetH, x, y, patch, w, h) {
    const targetPlaneSize = targetW * targetH;
    const patchPlaneSize = w * h;

    for (let c = 0; c < 3; c++) {
        const targetOffset = c * targetPlaneSize;
        const patchOffset = c * patchPlaneSize;
        for (let py = 0; py < h; py++) {
            const targetY = y + py;
            if (targetY >= targetH) continue;
            
            const targetRowStart = targetOffset + targetY * targetW;
            const patchRowStart = patchOffset + py * w;
            
            const length = Math.min(w, targetW - x);
            if (length <= 0) continue;

            const patchSlice = patch.subarray(patchRowStart, patchRowStart + w);
            target.set(patchSlice.subarray(0, length), targetRowStart + x);
        }
    }
}


function getWaifu2xTasks(config) {
    const { arch, style, noise, scale } = config.waifu2x;
    
    // 如果选择1倍放大且无降噪，则没有任务
    if (scale === 1 && noise === '0') {
        return [];
    }
    
    const effectiveStyle = (arch === 'cunet') ? 'art' : style;
    const basePath = `./models/waifu2x/${arch}/${effectiveStyle}/`;
    let tasks = [];

    if (arch === 'swin_unet') {
        if (noise !== '0') {
            tasks.push({ modelPath: `${basePath}noise${noise}.onnx`, scale: 1 });
        }
        if (scale > 1) {
             tasks.push({ modelPath: `${basePath}scale${scale}x.onnx`, scale: scale });
        }
    } else if (arch === 'cunet') {
        // CUNet只支持2x放大
        if (scale !== 2) {
             console.warn(`[WORKER] CUNet仅支持2倍放大，但请求了${scale}倍。将强制执行2倍放大。`);
        }
        let modelName;
        if (noise === '0') {
            modelName = `scale2x.onnx`; 
        } else {
            modelName = `noise${noise}_scale2x.onnx`;
        }
        tasks.push({ modelPath: basePath + modelName, scale: 2 });
    }
    
    console.log(`[WORKER] 生成的任务列表:`, tasks);
    return tasks;
}