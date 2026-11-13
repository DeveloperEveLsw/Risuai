"use strict";
// Reviewed against the immutable public 3.2.0 artifact, SHA256
// ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9.
// All 26 dialogs, two selection helpers, three returning createBtn callbacks,
// and two manual-recovery Promise consumers are pinned by source/AST hashes.
// Memory/full imports retain the author's new target-capture/selection guards.
const profile = {
  calls: [
    {
      start: 1083655,
      end: 1084643,
      sha256:
        "498e74236ab69f62a437c136690507740291a9c42d7c02bd567d463c1e890748",
      callee: "window.confirm",
      calleeEnd: 1083669,
      arity: 1,
      function: {
        start: 1083508,
        end: 1085408,
        sha256:
          "369275a7b1bd35707ae583836266bab47952f233d21a99ae926f3d083e0f5343",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "embed-large",
      source: "WygLoreLeaf-latest.js",
      line: 1021,
    },
    {
      start: 1085459,
      end: 1085654,
      sha256:
        "d50a0568ae70ca31f5e4852926910a7bcf629271eea71edd4b7df6ecbfc57901",
      callee: "window.confirm",
      calleeEnd: 1085473,
      arity: 1,
      function: {
        start: 1085446,
        end: 1086130,
        sha256:
          "704c972e41e2a3d3d10e147e8080be2288777901a7caad1439796761c86ce6ce",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "embed-restore",
      source: "WygLoreLeaf-latest.js",
      line: 1027,
    },
    {
      start: 1086179,
      end: 1086349,
      sha256:
        "6d5187ea8d2963699d95152b7c846690a0df414863a2836887b4144964ae5212",
      callee: "window.confirm",
      calleeEnd: 1086193,
      arity: 1,
      function: {
        start: 1086166,
        end: 1086608,
        sha256:
          "a66399fb0b157a8fb317184c8640bea09c5a153f1ad30f9ba8fdaed3e06a95b5",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "embed-clear",
      source: "WygLoreLeaf-latest.js",
      line: 1027,
    },
    {
      start: 1087461,
      end: 1087662,
      sha256:
        "49a80c865d4ea99374c9896c6a172514abfb0c0c567f15865bed9afcf5433a99",
      callee: "window.confirm",
      calleeEnd: 1087475,
      arity: 1,
      function: {
        start: 1087343,
        end: 1088269,
        sha256:
          "95611764b3bb24e208a9e6445178e24a6924028196d058408f644add2619a492",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "memory-import",
      source: "WygLoreLeaf-latest.js",
      line: 1027,
    },
    {
      start: 1109803,
      end: 1110319,
      sha256:
        "eda9ed29e8f99301013772bc8fb292c8f401252a11211a4214ba9c56c640c054",
      callee: "window.confirm",
      calleeEnd: 1109817,
      arity: 1,
      function: {
        start: 1108966,
        end: 1113274,
        sha256:
          "ebbb7396f8012c5c1d12cef530c6672c844d002a8cc0af22637ccf750b79c058",
        type: "FunctionDeclaration",
        name: "runManualColdStart",
        async: true,
      },
      id: "loss-recovery",
      source: "WygLoreLeaf-latest.js",
      line: 1028,
    },
    {
      start: 1110645,
      end: 1110664,
      sha256:
        "e30ba9c2b0a54625cc189cc2fda0ccb72ec5fefd0315c16ccd901e0d514f44e6",
      callee: "window.confirm",
      calleeEnd: 1110659,
      arity: 1,
      function: {
        start: 1108966,
        end: 1113274,
        sha256:
          "ebbb7396f8012c5c1d12cef530c6672c844d002a8cc0af22637ccf750b79c058",
        type: "FunctionDeclaration",
        name: "runManualColdStart",
        async: true,
      },
      id: "cold-start-large",
      source: "WygLoreLeaf-latest.js",
      line: 1032,
    },
    {
      start: 1118507,
      end: 1118530,
      sha256:
        "dd13539f5b533b3461fdce5cb52d0378a808eb055a58c1b176d150ab09dcdb64",
      callee: "globalThis.confirm",
      calleeEnd: 1118525,
      arity: 1,
      function: {
        start: 1116949,
        end: 1118822,
        sha256:
          "1d573f63140791499bb7ddf06d2498ce646ff58982fbc1130c4cad68a9764245",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "garden-reset",
      source: "WygLoreLeaf-latest.js",
      line: 1045,
    },
    {
      start: 1140655,
      end: 1140674,
      sha256:
        "e30ba9c2b0a54625cc189cc2fda0ccb72ec5fefd0315c16ccd901e0d514f44e6",
      callee: "window.confirm",
      calleeEnd: 1140669,
      arity: 1,
      function: {
        start: 1137295,
        end: 1147526,
        sha256:
          "8acc9b54cbdafdcc6eacf39ce60c631717dc88cae63b8b08f6f2bd57be217af5",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "index-large",
      source: "WygLoreLeaf-latest.js",
      line: 1050,
    },
    {
      start: 1149785,
      end: 1150695,
      sha256:
        "eb7b6861be462d51ece8e86753a97c65ee68b0dbeca390475b179ae26cbce51b",
      callee: "window.confirm",
      calleeEnd: 1149799,
      arity: 1,
      function: {
        start: 1149772,
        end: 1151010,
        sha256:
          "9549d19401ac39a0500f2ec55b28d32a677aea950f1f386ce61ca71d343978d9",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "cache-clear",
      source: "WygLoreLeaf-latest.js",
      line: 1050,
    },
    {
      start: 1152603,
      end: 1152622,
      sha256:
        "e30ba9c2b0a54625cc189cc2fda0ccb72ec5fefd0315c16ccd901e0d514f44e6",
      callee: "window.confirm",
      calleeEnd: 1152617,
      arity: 1,
      function: {
        start: 1151616,
        end: 1153014,
        sha256:
          "3accf1850be748c1deb65cc2c6f0fb8f33ebdfe86c4478a69988d6b8b5b4fcbe",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "index-clear",
      source: "WygLoreLeaf-latest.js",
      line: 1066,
    },
    {
      start: 1168894,
      end: 1169172,
      sha256:
        "e94f2b7af4a57b61a81457b652a311ff9c77e97659e1eb45fe330719baf0289a",
      callee: "window.confirm",
      calleeEnd: 1168908,
      arity: 1,
      function: {
        start: 1168784,
        end: 1169684,
        sha256:
          "a00b0dba5e5f8d4e673765d01d3a89d8890838e5b96cce8b2eb8038189c5e22e",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "settings-import",
      source: "WygLoreLeaf-latest.js",
      line: 1067,
    },
    {
      start: 1170610,
      end: 1170847,
      sha256:
        "065b9ad4b1baa7b35c2b38a34519028e401dddbad5128921948ea824ffbe66cd",
      callee: "window.confirm",
      calleeEnd: 1170624,
      arity: 1,
      function: {
        start: 1170429,
        end: 1171445,
        sha256:
          "77f17f6f8f228db19253c582af0affeb5115d80adcf6cd9cca5b99f628caa850",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "full-import",
      source: "WygLoreLeaf-latest.js",
      line: 1067,
    },
    {
      start: 1173525,
      end: 1173776,
      sha256:
        "0c7ffb19294f63986a15fa0b4af63befc974bb958624572a390bef6190668b8a",
      callee: "window.confirm",
      calleeEnd: 1173539,
      arity: 1,
      function: {
        start: 1173512,
        end: 1174611,
        sha256:
          "7ade97372fa27d41a701ce57f0981304126cc88ac5c71f35bb13a4628d54ecc2",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "storage-wipe",
      source: "WygLoreLeaf-latest.js",
      line: 1067,
    },
    {
      start: 1183918,
      end: 1184414,
      sha256:
        "c4024e9c2f1f02f271aac9d24ffbf762a4c7fe597156abcd2a171b9ac055ebf3",
      callee: "globalThis.confirm",
      calleeEnd: 1183936,
      arity: 1,
      function: {
        start: 1183837,
        end: 1185054,
        sha256:
          "37a90e28cf9eabbb72c0f356306fff137ee5280b153855ceb6d56f6ae6e37b8a",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "large-key-delete",
      source: "WygLoreLeaf-latest.js",
      line: 1067,
    },
    {
      start: 1191838,
      end: 1192436,
      sha256:
        "df31eed47d4ef9e8d190cb7b07bfdd5eb41a99733b664a5fd7718ecb9b2d0b3e",
      callee: "globalThis.confirm",
      calleeEnd: 1191856,
      arity: 1,
      function: {
        start: 1191757,
        end: 1193291,
        sha256:
          "e6f4abb473bb02752d36402508146f9fc647f7c912ca48caa7ce5360be5a943a",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "orphan-delete",
      source: "WygLoreLeaf-latest.js",
      line: 1075,
    },
    {
      start: 1193988,
      end: 1194655,
      sha256:
        "bd9f1befc0d36e1341ae77cf57ca334896f056ffe0b12477f3489730050d6705",
      callee: "globalThis.confirm",
      calleeEnd: 1194006,
      arity: 1,
      function: {
        start: 1193607,
        end: 1195741,
        sha256:
          "55fa02de99f40a79c840f5a09183a57e5ac5881798d2f3b22bb149d76aeebf98",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "orphans-delete",
      source: "WygLoreLeaf-latest.js",
      line: 1083,
    },
    {
      start: 1314218,
      end: 1314472,
      sha256:
        "56f7ae8a0747b88dd1df4253568238f77e6a806e1fe190da8a58a7cbd60af680",
      callee: "confirm",
      calleeEnd: 1314225,
      arity: 1,
      function: {
        start: 1313501,
        end: 1315097,
        sha256:
          "0f099ffcb74e20474d6cf5224764074079928c7d14846b319b3e6b5c0f1f0ecd",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "toggle-cleanup",
      source: "WygLoreLeaf-latest.js",
      line: 1093,
    },
    {
      start: 1315903,
      end: 1316168,
      sha256:
        "b001b7b7cadce3d1fad4a1fe9b93d05e986a37074c180f3a1567862f5e520446",
      callee: "confirm",
      calleeEnd: 1315910,
      arity: 1,
      function: {
        start: 1315889,
        end: 1316410,
        sha256:
          "ec60b7fc36eb97738026e24843ceed5849f92e9e7dcd4104e0e55a3d05027419",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "toggle-reset",
      source: "WygLoreLeaf-latest.js",
      line: 1095,
    },
    {
      start: 1381246,
      end: 1381513,
      sha256:
        "d489cd19d7d6e08d43890a8e7e8c5accc7162590175812ec9e6e98912fe41c96",
      callee: "window.confirm",
      calleeEnd: 1381260,
      arity: 1,
      function: {
        start: 1381219,
        end: 1382198,
        sha256:
          "73e31d6384fb1ff643b8b9892c41927deda8743fd330c37dc2e4f62be57aefbb",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "duplicate-merge",
      source: "WygLoreLeaf-latest.js",
      line: 1095,
    },
    {
      start: 1482642,
      end: 1482781,
      sha256:
        "c3cd1914e4a2087fdbb77aaa8576d96b362af8bcbf5339520cf8ae048e8afd40",
      callee: "confirm",
      calleeEnd: 1482649,
      arity: 1,
      function: {
        start: 1482597,
        end: 1482848,
        sha256:
          "5d4f52c749b97836aa1289e84a57f9a350557c1093ca8b6806458f59356dc263",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "hand-summary-delete",
      source: "WygLoreLeaf-latest.js",
      line: 1106,
    },
    {
      start: 1504574,
      end: 1505247,
      sha256:
        "6e450c036b6da4dd18e5067d9448584c652b8327bfceaf721a6b2dcd7b47ff5f",
      callee: "confirm",
      calleeEnd: 1504581,
      arity: 1,
      function: {
        start: 1504158,
        end: 1505248,
        sha256:
          "51453436168d1f9f25a8f9aa66143abd9dc0543e7570d0d45da68292d48b0544",
        type: "FunctionDeclaration",
        name: "confirmLargeRecapSelection",
        async: false,
      },
      id: "recap-large-selection",
      source: "WygLoreLeaf-latest.js",
      line: 1121,
    },
    {
      start: 1861593,
      end: 1861864,
      sha256:
        "48cf29304e5302ba6d030888c30b36847ab3b21163781a76fa4b5d076b9cd62f",
      callee: "confirm",
      calleeEnd: 1861600,
      arity: 1,
      function: {
        start: 1861554,
        end: 1862019,
        sha256:
          "aac80b19f64959a6efa581e3d659243d2f712a899d9ca2ae9ee9dae0f1246318",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "providers-clear",
      source: "WygLoreLeaf-latest.js",
      line: 1334,
    },
    {
      start: 1862543,
      end: 1862766,
      sha256:
        "79a3633b14fc4d4b618febee276b101e17fc116e04a8a8d5a5872e2f1ecf9587",
      callee: "confirm",
      calleeEnd: 1862550,
      arity: 1,
      function: {
        start: 1862504,
        end: 1862926,
        sha256:
          "ac4016cbd555a104fa5017eba08a42bab305b2809a0c866f8419576aa973b160",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "providers-reset",
      source: "WygLoreLeaf-latest.js",
      line: 1336,
    },
    {
      start: 1892940,
      end: 1893492,
      sha256:
        "3f8678b9aabae24e4ebae7c14bdb9ca6dd542ede90610ddde6e4e463da32c1bc",
      callee: "window.confirm",
      calleeEnd: 1892954,
      arity: 1,
      function: {
        start: 1892822,
        end: 1896777,
        sha256:
          "50c3a8f3cfe9ca146d172008f277891316fb2885fe3e4d688795f00b4df5fe8a",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "copilot-login",
      source: "WygLoreLeaf-latest.js",
      line: 1365,
    },
    {
      start: 1924558,
      end: 1924699,
      sha256:
        "3f739a89261167eaad62a71a36aff343411c0bf971ac0f332c3b0b0addd84a9c",
      callee: "window.confirm",
      calleeEnd: 1924572,
      arity: 1,
      function: {
        start: 1924553,
        end: 1924780,
        sha256:
          "3447f9434ba83240dcee3f33db1047131aa6c7a191d40d1f5d9d293ab3fc4439",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      id: "telemetry-clear",
      source: "WygLoreLeaf-latest.js",
      line: 1387,
    },
    {
      start: 2006743,
      end: 2006882,
      sha256:
        "c0cf687db66a323a6b925b4f0918e0782e8bffc23d1e96edb954010d91b7488e",
      callee: "confirm",
      calleeEnd: 2006750,
      arity: 1,
      function: {
        start: 2006733,
        end: 2006928,
        sha256:
          "a51a77d9e46d388f595f68f48d087461c7e498d7f22f7013e21cadb7206a809f",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "usage-clear",
      source: "WygLoreLeaf-latest.js",
      line: 1394,
    },
  ],
  helpers: [
    {
      start: 1501666,
      end: 1501705,
      sha256:
        "c706e4e92104c0280c30ed100d70c4e0fa3e594debd584b266837aad383bc476",
      function: {
        start: 1501468,
        end: 1502159,
        sha256:
          "6e083194fe1940403d05a0280da3000895e8c648e668edf5add0eb428d4ace8a",
        type: "FunctionDeclaration",
        name: "openDraft",
        async: false,
      },
    },
    {
      start: 1502367,
      end: 1502415,
      sha256:
        "19fc7119dcb18d0b45e1f767d55414f1347536f3c3a56b19849ab0d824d53bea",
      function: {
        start: 1502159,
        end: 1503336,
        sha256:
          "f681304e6d1fa2fd73b78a281a93db6dda19b645e2355ac941bf2f738b8b6f74",
        type: "FunctionDeclaration",
        name: "openProseDraft",
        async: true,
      },
    },
  ],
  consumers: [
    {
      start: 1497113,
      end: 1497198,
      sha256:
        "676d71fa9c048eb9ca2992f06193f4bc76b249d17e85a231bc8a5c8054c59de5",
      callee: "openProseDraft",
      function: {
        start: 1497109,
        end: 1497198,
        sha256:
          "9887b22145bfb2bce65bd97623fcfeb48f89821b0ce70ac82c487cff7ec8ee37",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      returnsPromise: true,
      property: "onClick",
    },
    {
      start: 1497388,
      end: 1497468,
      sha256:
        "41dc1f392c9e201afcb5275bd7f44274ff4ee90bd959f07ac4079e5cfba322da",
      callee: "openDraft",
      function: {
        start: 1497384,
        end: 1497468,
        sha256:
          "fd1e8cf0ffef341939a3c3d908ba5afab169463e0135461b352c4a88b214af9f",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      returnsPromise: true,
      property: "onClick",
    },
    {
      start: 1501384,
      end: 1501400,
      sha256:
        "61f4a423c3b36c8a8f37bcd3cd7fc8233a2234e118a06b02716efd05684c64fe",
      callee: "openDraft",
      function: {
        start: 1501380,
        end: 1501400,
        sha256:
          "58d3ccf51b2d95c91c34c77e9d72c4093cc64404c3f98f53606ed02d8dc82114",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      returnsPromise: true,
      property: "onClick",
    },
  ],
  functions: [
    {
      start: 858038,
      end: 858727,
      sha256:
        "3ceb32a99c906188bf29338b28101064dcb5fd5a4432628111ff7d93d430d5c3",
      type: "FunctionDeclaration",
      name: "createBtn",
      async: false,
    },
    {
      start: 1501468,
      end: 1502159,
      sha256:
        "6e083194fe1940403d05a0280da3000895e8c648e668edf5add0eb428d4ace8a",
      type: "FunctionDeclaration",
      name: "openDraft",
      async: false,
    },
    {
      start: 1504158,
      end: 1505248,
      sha256:
        "51453436168d1f9f25a8f9aa66143abd9dc0543e7570d0d45da68292d48b0544",
      type: "FunctionDeclaration",
      name: "confirmLargeRecapSelection",
      async: false,
    },
  ],
  manualConsumers: [
    {
      start: 1100420,
      end: 1100442,
      sha256:
        "b162c06659f6ee4b50fe2200dca91a35b79897d0fc9fe2483681fb74d759882f",
      function: {
        start: 1100415,
        end: 1100553,
        sha256:
          "96a9d1e317230517143138a24446a929e78668f27695df4b2fbc55fb4bdd9fe8",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      statement: {
        start: 1100420,
        end: 1100552,
        sha256:
          "989deede27af95aa2104dfc45a7e1227bf88356a8354bfa3e83dd376bf503b8e",
      },
    },
    {
      start: 1113311,
      end: 1113331,
      sha256:
        "9c708e434803d64de8761f9285f2198351c89f23a6746d06330e91dd4382ee96",
      function: {
        start: 1113306,
        end: 1113467,
        sha256:
          "ceac90ccba48464f3d7aa2bf27cf35241f182e084b08d5c598b2fa377e662fb9",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      statement: {
        start: 1113311,
        end: 1113466,
        sha256:
          "a805984ffa8ddd2878f6e46f90ac1fe67822e031c99a2dcaa00119f616259226",
      },
    },
  ],
};

function freeze(value) {
  if (value && typeof value === "object") {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}
module.exports = freeze(profile);
