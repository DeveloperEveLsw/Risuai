"use strict";
// Fixed AST/source profile reviewed against the pinned public 3.1.6 artifact.
const profile = {
  calls: [
    {
      start: 897652,
      end: 898640,
      sha256:
        "498e74236ab69f62a437c136690507740291a9c42d7c02bd567d463c1e890748",
      callee: "window.confirm",
      calleeEnd: 897666,
      arity: 1,
      function: {
        start: 897505,
        end: 899405,
        sha256:
          "369275a7b1bd35707ae583836266bab47952f233d21a99ae926f3d083e0f5343",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "embed-large",
      source: "src/ui/tabs/settings.js",
      line: 1671,
    },
    {
      start: 899456,
      end: 899651,
      sha256:
        "d50a0568ae70ca31f5e4852926910a7bcf629271eea71edd4b7df6ecbfc57901",
      callee: "window.confirm",
      calleeEnd: 899470,
      arity: 1,
      function: {
        start: 899443,
        end: 900127,
        sha256:
          "704c972e41e2a3d3d10e147e8080be2288777901a7caad1439796761c86ce6ce",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "embed-restore",
      source: "src/ui/tabs/settings.js",
      line: 1699,
    },
    {
      start: 900176,
      end: 900346,
      sha256:
        "6d5187ea8d2963699d95152b7c846690a0df414863a2836887b4144964ae5212",
      callee: "window.confirm",
      calleeEnd: 900190,
      arity: 1,
      function: {
        start: 900163,
        end: 900605,
        sha256:
          "a66399fb0b157a8fb317184c8640bea09c5a153f1ad30f9ba8fdaed3e06a95b5",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "embed-clear",
      source: "src/ui/tabs/settings.js",
      line: 1714,
    },
    {
      start: 901390,
      end: 901591,
      sha256:
        "49a80c865d4ea99374c9896c6a172514abfb0c0c567f15865bed9afcf5433a99",
      callee: "window.confirm",
      calleeEnd: 901404,
      arity: 1,
      function: {
        start: 901340,
        end: 902189,
        sha256:
          "abaa409d798ccc07aabde26613c7ba16ee20f4ffba2d089eef0655a8444e5b2d",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "memory-import",
      source: "src/ui/tabs/settings.js",
      line: 1744,
    },
    {
      start: 923721,
      end: 924237,
      sha256:
        "eda9ed29e8f99301013772bc8fb292c8f401252a11211a4214ba9c56c640c054",
      callee: "window.confirm",
      calleeEnd: 923735,
      arity: 1,
      function: {
        start: 922884,
        end: 927192,
        sha256:
          "ebbb7396f8012c5c1d12cef530c6672c844d002a8cc0af22637ccf750b79c058",
        type: "FunctionDeclaration",
        name: "runManualColdStart",
        async: true,
      },
      id: "loss-recovery",
      source: "src/ui/tabs/settings.js",
      line: 2223,
    },
    {
      start: 924563,
      end: 924582,
      sha256:
        "e30ba9c2b0a54625cc189cc2fda0ccb72ec5fefd0315c16ccd901e0d514f44e6",
      callee: "window.confirm",
      calleeEnd: 924577,
      arity: 1,
      function: {
        start: 922884,
        end: 927192,
        sha256:
          "ebbb7396f8012c5c1d12cef530c6672c844d002a8cc0af22637ccf750b79c058",
        type: "FunctionDeclaration",
        name: "runManualColdStart",
        async: true,
      },
      id: "cold-start-large",
      source: "src/ui/tabs/settings.js",
      line: 2235,
    },
    {
      start: 932425,
      end: 932448,
      sha256:
        "dd13539f5b533b3461fdce5cb52d0378a808eb055a58c1b176d150ab09dcdb64",
      callee: "globalThis.confirm",
      calleeEnd: 932443,
      arity: 1,
      function: {
        start: 930867,
        end: 932740,
        sha256:
          "1d573f63140791499bb7ddf06d2498ce646ff58982fbc1130c4cad68a9764245",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "garden-reset",
      source: "src/ui/tabs/settings.js",
      line: 2451,
    },
    {
      start: 954510,
      end: 954529,
      sha256:
        "e30ba9c2b0a54625cc189cc2fda0ccb72ec5fefd0315c16ccd901e0d514f44e6",
      callee: "window.confirm",
      calleeEnd: 954524,
      arity: 1,
      function: {
        start: 951150,
        end: 961379,
        sha256:
          "d5fa58f18ee0a8ee5fcfbcdccf7e0f540361d716c9976f82c074d495d23f65fe",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "index-large",
      source: "src/ui/tabs/settings.js",
      line: 3065,
    },
    {
      start: 963638,
      end: 964548,
      sha256:
        "eb7b6861be462d51ece8e86753a97c65ee68b0dbeca390475b179ae26cbce51b",
      callee: "window.confirm",
      calleeEnd: 963652,
      arity: 1,
      function: {
        start: 963625,
        end: 964863,
        sha256:
          "9549d19401ac39a0500f2ec55b28d32a677aea950f1f386ce61ca71d343978d9",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "cache-clear",
      source: "src/ui/tabs/settings.js",
      line: 3286,
    },
    {
      start: 966456,
      end: 966475,
      sha256:
        "e30ba9c2b0a54625cc189cc2fda0ccb72ec5fefd0315c16ccd901e0d514f44e6",
      callee: "window.confirm",
      calleeEnd: 966470,
      arity: 1,
      function: {
        start: 965469,
        end: 966867,
        sha256:
          "3accf1850be748c1deb65cc2c6f0fb8f33ebdfe86c4478a69988d6b8b5b4fcbe",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "index-clear",
      source: "src/ui/tabs/settings.js",
      line: 3316,
    },
    {
      start: 982721,
      end: 982999,
      sha256:
        "e94f2b7af4a57b61a81457b652a311ff9c77e97659e1eb45fe330719baf0289a",
      callee: "window.confirm",
      calleeEnd: 982735,
      arity: 1,
      function: {
        start: 982611,
        end: 983507,
        sha256:
          "0a400c34baf3abe789f4e7978821f2e6303e3f8634cf3d23efc48daa071d9420",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "settings-import",
      source: "src/ui/tabs/settings.js",
      line: 3726,
    },
    {
      start: 984358,
      end: 984595,
      sha256:
        "065b9ad4b1baa7b35c2b38a34519028e401dddbad5128921948ea824ffbe66cd",
      callee: "window.confirm",
      calleeEnd: 984372,
      arity: 1,
      function: {
        start: 984249,
        end: 985180,
        sha256:
          "164dff2f6a6489f12118c54f0b00d0e6219fb6956d63e9dee09cb1cb5a50ea68",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "full-import",
      source: "src/ui/tabs/settings.js",
      line: 3755,
    },
    {
      start: 987260,
      end: 987511,
      sha256:
        "0c7ffb19294f63986a15fa0b4af63befc974bb958624572a390bef6190668b8a",
      callee: "window.confirm",
      calleeEnd: 987274,
      arity: 1,
      function: {
        start: 987247,
        end: 988346,
        sha256:
          "7ade97372fa27d41a701ce57f0981304126cc88ac5c71f35bb13a4628d54ecc2",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "storage-wipe",
      source: "src/ui/tabs/settings.js",
      line: 3836,
    },
    {
      start: 997653,
      end: 998149,
      sha256:
        "c4024e9c2f1f02f271aac9d24ffbf762a4c7fe597156abcd2a171b9ac055ebf3",
      callee: "globalThis.confirm",
      calleeEnd: 997671,
      arity: 1,
      function: {
        start: 997572,
        end: 998789,
        sha256:
          "37a90e28cf9eabbb72c0f356306fff137ee5280b153855ceb6d56f6ae6e37b8a",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "large-key-delete",
      source: "src/ui/tabs/settings.js",
      line: 4113,
    },
    {
      start: 1005573,
      end: 1006171,
      sha256:
        "df31eed47d4ef9e8d190cb7b07bfdd5eb41a99733b664a5fd7718ecb9b2d0b3e",
      callee: "globalThis.confirm",
      calleeEnd: 1005591,
      arity: 1,
      function: {
        start: 1005492,
        end: 1007026,
        sha256:
          "e6f4abb473bb02752d36402508146f9fc647f7c912ca48caa7ce5360be5a943a",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "orphan-delete",
      source: "src/ui/tabs/settings.js",
      line: 4337,
    },
    {
      start: 1007723,
      end: 1008390,
      sha256:
        "bd9f1befc0d36e1341ae77cf57ca334896f056ffe0b12477f3489730050d6705",
      callee: "globalThis.confirm",
      calleeEnd: 1007741,
      arity: 1,
      function: {
        start: 1007342,
        end: 1009476,
        sha256:
          "55fa02de99f40a79c840f5a09183a57e5ac5881798d2f3b22bb149d76aeebf98",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "orphans-delete",
      source: "src/ui/tabs/settings.js",
      line: 4392,
    },
    {
      start: 1127829,
      end: 1128082,
      sha256:
        "6b537cf9517413f713ffcc93528192a9b2d557a1de28529026d38f2f2f3eabe5",
      callee: "confirm",
      calleeEnd: 1127836,
      arity: 1,
      function: {
        start: 1127113,
        end: 1128707,
        sha256:
          "3ec0cc47c544c13431fdcd9ad045e77f8fa5f6f63d6a75d22a0152b35d881fdd",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "toggle-cleanup",
      source: "src/ui/tabs/cbs-toggles.js",
      line: 636,
    },
    {
      start: 1129513,
      end: 1129778,
      sha256:
        "b001b7b7cadce3d1fad4a1fe9b93d05e986a37074c180f3a1567862f5e520446",
      callee: "confirm",
      calleeEnd: 1129520,
      arity: 1,
      function: {
        start: 1129499,
        end: 1130020,
        sha256:
          "ec60b7fc36eb97738026e24843ceed5849f92e9e7dcd4104e0e55a3d05027419",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "toggle-reset",
      source: "src/ui/tabs/cbs-toggles.js",
      line: 677,
    },
    {
      start: 1194536,
      end: 1194803,
      sha256:
        "d489cd19d7d6e08d43890a8e7e8c5accc7162590175812ec9e6e98912fe41c96",
      callee: "window.confirm",
      calleeEnd: 1194550,
      arity: 1,
      function: {
        start: 1194509,
        end: 1195483,
        sha256:
          "42f64c423087a8503daa9869dd03af969cca494a46b53902abb4cab3e1df1b8e",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "duplicate-merge",
      source: "src/ui/tabs/data-recovery.js",
      line: 691,
    },
    {
      start: 1290106,
      end: 1290245,
      sha256:
        "c3cd1914e4a2087fdbb77aaa8576d96b362af8bcbf5339520cf8ae048e8afd40",
      callee: "confirm",
      calleeEnd: 1290113,
      arity: 1,
      function: {
        start: 1290061,
        end: 1290312,
        sha256:
          "5d4f52c749b97836aa1289e84a57f9a350557c1093ca8b6806458f59356dc263",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "hand-summary-delete",
      source: "src/ui/hand-summary-modal.js",
      line: 222,
    },
    {
      start: 1311900,
      end: 1312573,
      sha256:
        "6e450c036b6da4dd18e5067d9448584c652b8327bfceaf721a6b2dcd7b47ff5f",
      callee: "confirm",
      calleeEnd: 1311907,
      arity: 1,
      function: {
        start: 1311484,
        end: 1312574,
        sha256:
          "51453436168d1f9f25a8f9aa66143abd9dc0543e7570d0d45da68292d48b0544",
        type: "FunctionDeclaration",
        name: "confirmLargeRecapSelection",
        async: false,
      },
      id: "recap-large-selection",
      source: "src/ui/recap-reading-view.js",
      line: 375,
    },
    {
      start: 1680654,
      end: 1680925,
      sha256:
        "48cf29304e5302ba6d030888c30b36847ab3b21163781a76fa4b5d076b9cd62f",
      callee: "confirm",
      calleeEnd: 1680661,
      arity: 1,
      function: {
        start: 1680615,
        end: 1681080,
        sha256:
          "aac80b19f64959a6efa581e3d659243d2f712a899d9ca2ae9ee9dae0f1246318",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "providers-clear",
      source: "src/ui/tabs/provider.js",
      line: 170,
    },
    {
      start: 1681604,
      end: 1681827,
      sha256:
        "79a3633b14fc4d4b618febee276b101e17fc116e04a8a8d5a5872e2f1ecf9587",
      callee: "confirm",
      calleeEnd: 1681611,
      arity: 1,
      function: {
        start: 1681565,
        end: 1681987,
        sha256:
          "ac4016cbd555a104fa5017eba08a42bab305b2809a0c866f8419576aa973b160",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "providers-reset",
      source: "src/ui/tabs/provider.js",
      line: 187,
    },
    {
      start: 1711946,
      end: 1712498,
      sha256:
        "3f8678b9aabae24e4ebae7c14bdb9ca6dd542ede90610ddde6e4e463da32c1bc",
      callee: "window.confirm",
      calleeEnd: 1711960,
      arity: 1,
      function: {
        start: 1711828,
        end: 1715771,
        sha256:
          "a602f82cf0f08b95680ce765d2849f112f4d74620aee5c7c20275ce656734baf",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "copilot-login",
      source: "src/ui/tabs/provider.js",
      line: 972,
    },
    {
      start: 1743473,
      end: 1743614,
      sha256:
        "3f739a89261167eaad62a71a36aff343411c0bf971ac0f332c3b0b0addd84a9c",
      callee: "window.confirm",
      calleeEnd: 1743487,
      arity: 1,
      function: {
        start: 1743468,
        end: 1743694,
        sha256:
          "ef40fa575fa187a8af178953edec9991a96831446f6e5971685a21f6a04e14c4",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      id: "telemetry-clear",
      source: "src/ui/tabs/telemetry-log.js",
      line: 143,
    },
    {
      start: 1823470,
      end: 1823609,
      sha256:
        "c0cf687db66a323a6b925b4f0918e0782e8bffc23d1e96edb954010d91b7488e",
      callee: "confirm",
      calleeEnd: 1823477,
      arity: 1,
      function: {
        start: 1823460,
        end: 1823655,
        sha256:
          "a51a77d9e46d388f595f68f48d087461c7e498d7f22f7013e21cadb7206a809f",
        type: "ArrowFunctionExpression",
        name: null,
        async: true,
      },
      id: "usage-clear",
      source: "src/ui/tabs/usage.js",
      line: 71,
    },
  ],
  helpers: [
    {
      start: 1309005,
      end: 1309044,
      sha256:
        "c706e4e92104c0280c30ed100d70c4e0fa3e594debd584b266837aad383bc476",
      function: {
        start: 1308808,
        end: 1309497,
        sha256:
          "5db1f2813247b453425f0d4b6ea83023270652f1510965d6a948017025c36e65",
        type: "FunctionDeclaration",
        name: "openDraft",
        async: false,
      },
    },
    {
      start: 1309704,
      end: 1309752,
      sha256:
        "19fc7119dcb18d0b45e1f767d55414f1347536f3c3a56b19849ab0d824d53bea",
      function: {
        start: 1309497,
        end: 1310671,
        sha256:
          "2ca4ac02aa75df4049789b5ca95ac321f7d8bd00e27f18e409438908174a20eb",
        type: "FunctionDeclaration",
        name: "openProseDraft",
        async: true,
      },
    },
  ],
  consumers: [
    {
      start: 1304483,
      end: 1304564,
      sha256:
        "1ec31fecc257c7b3f8f446a3dd2080ff57614135e7adf4ef15754b93ae5a12ae",
      callee: "openProseDraft",
      function: {
        start: 1304479,
        end: 1304564,
        sha256:
          "bdac31f285dbf0526a1158dd04bfe6117c6a62438efb9cd7bd86b51a0db58605",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      returnsPromise: true,
      property: "onClick",
    },
    {
      start: 1304753,
      end: 1304829,
      sha256:
        "097d855facefdba4fa2552798daccc17b98139f9ae26c68ea8dbfe2a1bd2fc78",
      callee: "openDraft",
      function: {
        start: 1304749,
        end: 1304829,
        sha256:
          "825e3ca6e29dccadb00328602a051ad990100ea3d70f2a136fe29170cca58986",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      returnsPromise: true,
      property: "onClick",
    },
    {
      start: 1308726,
      end: 1308742,
      sha256:
        "61f4a423c3b36c8a8f37bcd3cd7fc8233a2234e118a06b02716efd05684c64fe",
      callee: "openDraft",
      function: {
        start: 1308722,
        end: 1308742,
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
      start: 681532,
      end: 682221,
      sha256:
        "3ceb32a99c906188bf29338b28101064dcb5fd5a4432628111ff7d93d430d5c3",
      type: "FunctionDeclaration",
      name: "createBtn",
      async: false,
    },
    {
      start: 1308808,
      end: 1309497,
      sha256:
        "5db1f2813247b453425f0d4b6ea83023270652f1510965d6a948017025c36e65",
      type: "FunctionDeclaration",
      name: "openDraft",
      async: false,
    },
    {
      start: 1311484,
      end: 1312574,
      sha256:
        "51453436168d1f9f25a8f9aa66143abd9dc0543e7570d0d45da68292d48b0544",
      type: "FunctionDeclaration",
      name: "confirmLargeRecapSelection",
      async: false,
    },
  ],
  manualConsumers: [
    {
      start: 914338,
      end: 914360,
      sha256:
        "b162c06659f6ee4b50fe2200dca91a35b79897d0fc9fe2483681fb74d759882f",
      function: {
        start: 914333,
        end: 914471,
        sha256:
          "96a9d1e317230517143138a24446a929e78668f27695df4b2fbc55fb4bdd9fe8",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      statement: {
        start: 914338,
        end: 914470,
        sha256:
          "989deede27af95aa2104dfc45a7e1227bf88356a8354bfa3e83dd376bf503b8e",
      },
    },
    {
      start: 927229,
      end: 927249,
      sha256:
        "9c708e434803d64de8761f9285f2198351c89f23a6746d06330e91dd4382ee96",
      function: {
        start: 927224,
        end: 927385,
        sha256:
          "ceac90ccba48464f3d7aa2bf27cf35241f182e084b08d5c598b2fa377e662fb9",
        type: "ArrowFunctionExpression",
        name: null,
        async: false,
      },
      statement: {
        start: 927229,
        end: 927384,
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
