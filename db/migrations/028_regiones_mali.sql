-- ═════════════════════════════════════════════════════════════════════════════
-- 028 · LAS REGIONES DE MALI, UN COMERCIAL EN VARIAS ZONAS, Y OBJETIVOS POR ZONA
--
-- Migration independiente. NO toca la 027 ni ninguna de las tres que están
-- verificadas (auditoría, 027, núcleo). Solo añade.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- EL CONTORNO
--
-- Viene de Natural Earth `ne_10m_admin_1_states_provinces`, que es DOMINIO
-- PÚBLICO: uso libre y sin atribución obligatoria.
--
-- Son las NUEVE demarcaciones reales de Mali. Kidal va por separado, con su
-- polígono y sus datos, y NO se fusiona con Gao: si algún día hace falta un
-- grupo comercial Gao+Kidal, eso se hace encima, como agrupación, sin tocar
-- las demarcaciones de verdad.
--
-- El polígono está SIMPLIFICADO a 676 puntos en total (~13 KB) con
-- Douglas-Peucker a 0,02 grados, unos dos kilómetros. A tamaño de pantalla
-- no se ve la diferencia y va cuatro veces más rápido que los 2.745
-- originales en un móvil con datos justos.
--
-- Y el mapa NO depende de internet: el polígono vive en la base y se dibuja en
-- SVG. Ni Leaflet ni tiles de nadie. En una zona sin cobertura funciona igual.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- EL CENTROIDE ESTÁ CALCULADO, NO ESCRITO
--
-- Sale del propio polígono, con la fórmula del centroide, no del centro de la
-- caja que lo rodea. No es un detalle: Mali tiene una frontera tan alargada que
-- el centro de la caja de Gao cae FUERA del país, en el desierto de Níger. Un
-- punto en el mar marca la zona donde no hay nada.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- EL POTENCIAL NACE EN NULL, Y NO EN CERO
--
-- población, comercios estimados, clientes potenciales, dificultad.
--
-- Cero y NULL no son lo mismo. Un cero dice «sé que no tiene»; un NULL dice
-- «no lo sé». Si el campo vale cero, el ranking va a comparar una zona de la
-- que sabemos todo contra otra de la que no sabemos nada, y va a salir un
-- número. Un número inventado es peor que un hueco, porque no se ve que lo es.
--
-- Por eso son NULL y no `NOT NULL DEFAULT 0`, y por eso el ranking de zonas
-- tiene que IGNORAR los que no están rellenados en vez de tratar el NULL como
-- si fuera cero.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- LAS TRES COSAS DE OBJETIVO, SEPARADAS A PROPÓSITO
--
--   comercial → objetivo  (com_objetivos,   de la 027, NO se toca)
--   zona      → objetivo  (com_objetivos_zona, nueva aquí)
--   relación  → comercial ↔ zona  (com_comercial_zonas, nueva aquí)
--
-- No se fusionan. Un comercial puede tener objetivo propio y además trabajar
-- en tres zonas que tienen objetivos propios. Son tres mediciones que se
-- pueden responder por separado, y unirlas obligaría a decidir cuál manda,
-- y esa decisión no se puede tomar con criterio general: depende de si el
-- comercial lleva la zona o solo la cubre.
--

-- ─── 1 · LAS NUEVE REGIONES ────────────────────────────────────────────────
--
-- Solo se AÑADEN columnas. Las tres zonas de prueba (Dakar, Thiès,
-- Koulikoro) no se borran: se quedan, inactivas, con su código de prueba. Van a
-- salir en cualquier consulta que no filtre, así que se marcan aquí para que
-- se entienda de dónde viene cada fila.

ALTER TABLE com_zonas ADD COLUMN latitude  NUMERIC(10,7);
ALTER TABLE com_zonas ADD COLUMN longitude NUMERIC(10,7);
ALTER TABLE com_zonas ADD COLUMN poligono  JSONB;

-- El potencial. NULL de salida, y sin valor por defecto: si tuviera DEFAULT,
-- bastaría con crear una zona sin decir nada para que saliera un cero, que es
-- justo lo que no se quiere.
ALTER TABLE com_zonas ADD COLUMN poblacion           INTEGER;
ALTER TABLE com_zonas ADD COLUMN comercios_estimados INTEGER;
ALTER TABLE com_zonas ADD COLUMN clientes_potenciales INTEGER;
ALTER TABLE com_zonas ADD COLUMN dificultad          INTEGER
  CHECK (dificultad IS NULL OR dificultad BETWEEN 1 AND 5);

COMMENT ON COLUMN com_zonas.poblacion IS
  'Habitantes estimados. NULL = no se sabe. NO es cero.';
COMMENT ON COLUMN com_zonas.clientes_potenciales IS
  'Clientes que aún no son clientes. NULL = no se sabe. NO es cero.';
COMMENT ON COLUMN com_zonas.dificultad IS
  'De 1 (fácil) a 5 (muy difícil). NULL = sin evaluar. Es subjetivo y se asume.';

-- Una demarcación real no se repite.
CREATE UNIQUE INDEX uniq_com_zonas_codigo ON com_zonas(code);

INSERT INTO com_zonas (code, name, kind, latitude, longitude, poligono) VALUES
  ('BKO', 'Bamako', 'URBANA', 12.62832, -7.99681,
   '[[-8.0016,12.704],[-7.9532,12.685],[-7.9338,12.6358],[-7.9327,12.5751],[-7.9781,12.5429],[-8.0646,12.6044],[-8.0646,12.6704],[-8.0279,12.7011],[-8.0016,12.704]]'::jsonb),
  ('GAO', 'Gao', 'RURAL', 16.76709, 1.35894,
   '[[-0.3977,15.0021],[-0.4257,15.0026],[-0.4586,15.0755],[-0.5003,15.0797],[-0.694,16.047],[-0.71,16.6129],[-0.683,16.9329],[-1.6085,17.0357],[-1.7069,17.5145],[-0.9347,17.8861],[-0.8852,18.9553],[0.0652,18.7078],[0.5701,18.1336],[1.2037,17.6287],[1.7976,17.7574],[1.9758,17.9752],[4.2324,17.9752],[4.2356,16.9959],[4.1978,16.9652],[4.182,16.8096],[4.184,16.4161],[4.0606,16.2983],[3.9712,16.0861],[3.9832,15.984],[3.9099,15.9048],[3.8712,15.7148],[3.6922,15.6314],[3.5265,15.496],[3.5071,15.354],[3.0335,15.4265],[3.0002,15.3391],[1.3315,15.2836],[1.2709,15.2599],[0.9737,14.9913],[0.6838,14.9409],[0.5148,14.9936],[0.3532,14.9634],[0.2213,14.9959],[0.2185,14.911],[-0.2367,15.0656],[-0.3615,15.0177],[-0.3977,15.0021]]'::jsonb),
  ('KAY', 'Kayes', 'RURAL', 13.87307, -10.24304,
   '[[-11.8226,13.3067],[-11.8976,13.3712],[-11.8904,13.4651],[-12.0152,13.5644],[-12.0976,13.7044],[-12.0123,13.7512],[-11.9629,13.8295],[-11.9629,13.9092],[-12.0253,13.9852],[-11.9976,14.1662],[-12.0443,14.2649],[-12.1196,14.3106],[-12.1156,14.3551],[-12.2217,14.3912],[-12.2364,14.5195],[-12.165,14.6419],[-12.2641,14.7749],[-12.1389,14.7845],[-12.0704,14.7344],[-11.8204,14.9],[-11.8138,15.0285],[-11.8609,15.049],[-11.8457,15.1791],[-11.7271,15.5412],[-11.6149,15.5412],[-11.5154,15.6101],[-11.5273,15.6426],[-11.4096,15.6022],[-11.2982,15.451],[-11.0454,15.2702],[-10.9152,15.1029],[-10.8272,15.2877],[-10.7468,15.3411],[-10.7254,15.4331],[-10.3226,15.4371],[-10.0676,15.3647],[-9.8356,15.3711],[-9.6721,15.4307],[-9.4239,15.4405],[-9.4517,15.5883],[-9.3565,15.6979],[-9.3293,15.6552],[-9.3492,15.4956],[-9.1414,15.4956],[-8.849,15.2929],[-8.8041,15.245],[-8.741,15.026],[-8.677,14.982],[-8.492,14.942],[-8.463,14.6979],[-8.237,14.5199],[-8.1501,14.488],[-8.1321,14.34],[-8.162,14.32],[-8.472,14.3009],[-8.571,14.4129],[-8.65,14.314],[-8.8094,14.2882],[-8.7579,14.1374],[-8.7647,14.109],[-8.8187,14.1062],[-8.8466,13.9687],[-8.7513,13.9166],[-8.7039,13.8504],[-8.5926,13.8395],[-8.546,13.9517],[-8.4847,13.943],[-8.4526,13.8904],[-8.4576,13.8231],[-8.5549,13.6834],[-8.5406,13.5687],[-8.4488,13.4235],[-8.5607,13.1967],[-8.5713,13.0067],[-8.6337,12.8846],[-8.5982,12.8069],[-8.762,12.6899],[-8.891,12.65],[-9.003,12.523],[-9.045,12.4469],[-9.0101,12.4239],[-9.0278,12.4048],[-9.2659,12.4952],[-9.3982,12.4732],[-9.4073,12.4451],[-9.3092,12.3577],[-9.3368,12.2698],[-9.6282,12.1702],[-9.723,12.0254],[-9.8707,12.0521],[-10.2669,12.2178],[-10.3534,12.1665],[-10.3814,12.1801],[-10.4457,12.1207],[-10.5116,12.1181],[-10.5151,12.0529],[-10.5595,11.9952],[-10.6551,11.899],[-10.7114,11.8904],[-10.8078,12.0228],[-10.8049,12.096],[-10.9521,12.2195],[-11.0523,12.2025],[-11.1912,12.0144],[-11.3151,12.0133],[-11.5078,12.1916],[-11.4446,12.2895],[-11.4472,12.3745],[-11.3886,12.3845],[-11.3778,12.4802],[-11.4678,12.5435],[-11.4374,12.5708],[-11.4619,12.6731],[-11.4022,12.7317],[-11.4325,12.8355],[-11.4272,12.9186],[-11.3878,12.9271],[-11.3888,12.9706],[-11.4018,12.9895],[-11.4387,12.9589],[-11.423,13.0094],[-11.4503,13.0751],[-11.5331,13.1118],[-11.5723,13.2171],[-11.5543,13.2569],[-11.6131,13.3608],[-11.7412,13.4078],[-11.8171,13.3123],[-11.8226,13.3067]]'::jsonb),
  ('KDL', 'Kidal', 'RURAL', 19.43864, 1.15061,
   '[[0.0037,21.8489],[1.1465,21.1017],[1.1801,20.9953],[1.1546,20.7388],[1.2967,20.7335],[1.364,20.6577],[1.5597,20.5975],[1.644,20.5227],[1.6592,20.3975],[1.7781,20.3043],[1.855,20.2948],[1.8914,20.2318],[1.9553,20.2549],[2.0712,20.2133],[2.2008,20.2739],[2.3165,20.1802],[2.4004,20.0566],[2.946,19.9417],[3.1988,19.8205],[3.1994,19.5538],[3.2608,19.3883],[3.1929,19.3258],[3.1041,19.1355],[3.2849,18.9957],[3.3587,18.9769],[4.2286,19.1422],[4.2324,17.9752],[1.9758,17.9752],[1.7976,17.7574],[1.2037,17.6287],[0.5701,18.1336],[0.0652,18.7078],[-0.8852,18.9553],[-0.9643,19.0642],[-2.0434,19.9155],[-1.3208,20.2818],[-0.2219,21.153],[0.0037,21.8487],[0.0037,21.8489]]'::jsonb),
  ('KLR', 'Koulikoro', 'RURAL', 13.60878, -7.64111,
   '[[-8.9738,12.1876],[-8.9976,12.2348],[-8.9647,12.3463],[-9.045,12.4469],[-8.891,12.65],[-8.762,12.6899],[-8.5982,12.8069],[-8.6337,12.8846],[-8.5713,13.0067],[-8.5607,13.1967],[-8.4488,13.4235],[-8.5406,13.5687],[-8.5549,13.6834],[-8.4576,13.8231],[-8.4648,13.9227],[-8.5661,13.9457],[-8.5797,13.8631],[-8.618,13.837],[-8.7039,13.8504],[-8.7513,13.9166],[-8.8466,13.9687],[-8.8187,14.1062],[-8.7647,14.109],[-8.7579,14.1374],[-8.8094,14.2882],[-8.65,14.314],[-8.571,14.4129],[-8.472,14.3009],[-8.1321,14.34],[-8.1501,14.488],[-8.237,14.5199],[-8.485,14.733],[-8.4751,14.8759],[-8.507,14.963],[-8.677,14.982],[-8.741,15.026],[-8.8041,15.245],[-9.1414,15.4956],[-6.3201,15.4945],[-6.405,15.168],[-6.545,14.9439],[-6.436,14.781],[-6.382,14.536],[-6.4591,14.4459],[-6.617,14.4699],[-6.9001,13.998],[-6.9001,13.749],[-6.783,13.6239],[-6.764,13.4949],[-6.717,13.4519],[-6.7431,13.383],[-6.9261,13.342],[-6.971,13.3009],[-7.081,13.016],[-7.019,12.9449],[-6.886,12.9079],[-6.881,12.765],[-6.625,12.8089],[-6.512,12.7659],[-6.469,12.681],[-6.39,12.6999],[-6.3541,12.5919],[-6.261,12.5549],[-6.2271,12.502],[-6.211,12.4009],[-6.175,12.4069],[-6.07,12.308],[-5.951,12.2999],[-5.945,12.2119],[-5.982,12.1219],[-6.145,12.093],[-6.1531,12.013],[-6.201,12.0579],[-6.3021,12.073],[-6.347,12.0269],[-6.334,11.905],[-6.396,11.845],[-6.469,11.653],[-6.498,11.6499],[-6.543,11.6699],[-6.553,11.746],[-6.64,11.7479],[-6.897,11.871],[-6.947,11.862],[-6.968,11.978],[-7.015,11.9659],[-7.079,12.012],[-7.05,12.173],[-7.1161,12.4329],[-7.289,12.3059],[-7.319,12.227],[-7.48,12.1479],[-7.576,11.9809],[-7.862,11.8429],[-8.071,11.686],[-8.206,11.7049],[-8.4311,11.642],[-8.5394,11.4563],[-8.5496,11.4901],[-8.5752,11.4703],[-8.6568,11.4964],[-8.7265,11.6495],[-8.8472,11.6579],[-8.7978,11.9251],[-8.8198,12.0127],[-8.9221,12.0454],[-8.906,12.1477],[-8.9617,12.188],[-8.9738,12.1876]]'::jsonb),
  ('MPT', 'Mopti', 'RURAL', 14.70362, -3.52822,
   '[[-1.0431,14.8181],[-1.3503,14.715],[-1.6969,14.4961],[-1.9971,14.4707],[-2.0234,14.1986],[-2.1043,14.1512],[-2.4617,14.2809],[-2.5974,14.2223],[-2.8673,14.0005],[-2.9281,13.7996],[-2.8952,13.6516],[-3.0675,13.6068],[-3.1251,13.6773],[-3.1958,13.6749],[-3.2671,13.717],[-3.287,13.6978],[-3.2597,13.6583],[-3.284,13.5422],[-3.2486,13.2928],[-3.4485,13.2658],[-3.4616,13.1658],[-3.5969,13.1994],[-3.7986,13.3471],[-3.984,13.3965],[-3.918,13.4511],[-3.9593,13.4679],[-3.958,13.598],[-4.0411,13.8389],[-4.114,13.938],[-4.283,13.836],[-4.387,13.6469],[-4.603,13.5749],[-4.683,13.635],[-4.797,13.6259],[-4.855,13.5889],[-4.878,13.6939],[-4.857,13.779],[-4.8831,13.8249],[-4.854,13.9689],[-5.0511,13.9459],[-5.208,13.9899],[-5.187,14.1709],[-5.283,14.2989],[-5.664,14.532],[-5.621,14.5909],[-5.607,14.7629],[-5.546,14.9309],[-5.272,14.9729],[-5.1,15.1959],[-5.184,15.4709],[-5.343,15.499],[-5.3571,15.553],[-5.23,15.674],[-5.151,15.6089],[-4.688,15.581],[-4.377,15.7049],[-4.239,15.7189],[-4.1351,15.8099],[-4.054,15.8199],[-3.983,15.825],[-3.955,15.735],[-3.869,15.672],[-3.845,15.4939],[-3.642,15.4909],[-3.49,15.6],[-3.4821,15.7329],[-3.4211,15.7729],[-3.33,15.7709],[-3.202,15.8949],[-3.1641,15.8779],[-3.156,15.8329],[-2.924,15.8539],[-2.772,15.7169],[-2.597,15.3689],[-2.532,15.322],[-2.4501,15.304],[-2.147,15.4069],[-1.989,15.4279],[-1.686,15.4309],[-1.386,15.322],[-1.214,15.1789],[-0.7713,15.0566],[-0.8364,14.996],[-1.0431,14.8181]]'::jsonb),
  ('SEG', 'Ségou', 'RURAL', 13.8, -5.70137,
   '[[-3.9655,13.4892],[-4.1043,13.3827],[-4.166,13.2782],[-4.2388,13.2468],[-4.2581,13.2141],[-4.2348,13.1756],[-4.327,13.1686],[-4.3511,13.1183],[-4.2213,12.9213],[-4.2133,12.8072],[-4.244,12.7299],[-4.612,12.7029],[-4.629,12.7559],[-4.6911,12.7399],[-4.813,12.6119],[-5.065,12.5749],[-5.145,12.744],[-5.269,12.7959],[-5.434,12.607],[-5.579,12.8169],[-5.896,12.6519],[-5.9811,12.6729],[-6.004,12.6359],[-6.211,12.6049],[-6.261,12.5549],[-6.3541,12.5919],[-6.39,12.6999],[-6.469,12.681],[-6.512,12.7659],[-6.625,12.8089],[-6.881,12.765],[-6.886,12.9079],[-7.019,12.9449],[-7.081,13.016],[-6.971,13.3009],[-6.9261,13.342],[-6.7431,13.383],[-6.717,13.4519],[-6.764,13.4949],[-6.783,13.6239],[-6.9001,13.749],[-6.9001,13.998],[-6.617,14.4699],[-6.4591,14.4459],[-6.382,14.536],[-6.436,14.781],[-6.545,14.9439],[-6.405,15.168],[-6.3201,15.4945],[-5.5117,15.4934],[-5.3571,15.553],[-5.343,15.499],[-5.202,15.487],[-5.1,15.1959],[-5.272,14.9729],[-5.546,14.9309],[-5.607,14.7629],[-5.621,14.5909],[-5.664,14.532],[-5.283,14.2989],[-5.187,14.1709],[-5.208,13.9899],[-5.0511,13.9459],[-4.854,13.9689],[-4.8831,13.8249],[-4.857,13.779],[-4.878,13.6939],[-4.855,13.5889],[-4.797,13.6259],[-4.683,13.635],[-4.603,13.5749],[-4.387,13.6469],[-4.283,13.836],[-4.114,13.938],[-4.0411,13.8389],[-3.958,13.598],[-3.9601,13.4977],[-3.9655,13.4892]]'::jsonb),
  ('SKS', 'Sikasso', 'RURAL', 11.40776, -6.57512,
   '[[-4.4644,12.7173],[-4.4913,12.6628],[-4.3872,12.534],[-4.4516,12.4353],[-4.4061,12.3075],[-4.4882,12.3207],[-4.4935,12.2728],[-4.5855,12.1972],[-4.5702,12.1389],[-4.7613,12.0066],[-5.0893,11.9793],[-5.2752,11.8374],[-5.4124,11.8285],[-5.2871,11.7589],[-5.3076,11.6176],[-5.2339,11.576],[-5.2183,11.4222],[-5.2635,11.3902],[-5.2629,11.2516],[-5.3325,11.1216],[-5.5042,11.0727],[-5.5018,10.9702],[-5.4791,10.9755],[-5.4314,10.8447],[-5.4826,10.6842],[-5.4606,10.6446],[-5.4817,10.5353],[-5.5226,10.4255],[-5.594,10.4539],[-5.8781,10.3761],[-5.9047,10.2753],[-5.963,10.2827],[-6.0159,10.1899],[-6.1053,10.1893],[-6.24,10.2519],[-6.1806,10.4202],[-6.1903,10.4911],[-6.2613,10.5141],[-6.2044,10.6296],[-6.2466,10.6576],[-6.256,10.7265],[-6.427,10.6861],[-6.4359,10.6287],[-6.3992,10.5925],[-6.446,10.5523],[-6.5376,10.5697],[-6.6692,10.6542],[-6.6975,10.4883],[-6.6478,10.4327],[-6.6689,10.361],[-6.9612,10.3449],[-6.9971,10.2528],[-6.9594,10.1855],[-7.0158,10.1409],[-7.1064,10.2073],[-7.3634,10.2522],[-7.3723,10.3448],[-7.4444,10.3342],[-7.5015,10.4586],[-7.5564,10.4173],[-7.6644,10.4371],[-7.7776,10.3299],[-7.829,10.2117],[-7.9709,10.1551],[-7.9646,10.2589],[-7.9963,10.3283],[-8.1155,10.3602],[-8.1354,10.4273],[-8.2289,10.4234],[-8.2955,10.5374],[-8.3111,10.7353],[-8.3419,10.7632],[-8.3036,10.8749],[-8.3266,11.0238],[-8.3693,11.0542],[-8.5058,11.0528],[-8.5595,10.9716],[-8.6962,10.9627],[-8.6246,11.122],[-8.4988,11.2335],[-8.4926,11.2778],[-8.3767,11.2947],[-8.371,11.3206],[-8.4261,11.3405],[-8.3753,11.3677],[-8.5276,11.4234],[-8.5394,11.4563],[-8.4311,11.642],[-8.206,11.7049],[-8.071,11.686],[-7.862,11.8429],[-7.576,11.9809],[-7.48,12.1479],[-7.319,12.227],[-7.289,12.3059],[-7.212,12.348],[-7.171,12.4129],[-7.1161,12.4329],[-7.05,12.173],[-7.079,12.012],[-7.015,11.9659],[-6.968,11.978],[-6.947,11.862],[-6.897,11.871],[-6.64,11.7479],[-6.553,11.746],[-6.543,11.6699],[-6.469,11.653],[-6.396,11.845],[-6.334,11.905],[-6.347,12.0269],[-6.252,12.0769],[-6.1531,12.013],[-6.145,12.093],[-5.982,12.1219],[-5.945,12.2119],[-5.951,12.2999],[-6.07,12.308],[-6.175,12.4069],[-6.211,12.4009],[-6.261,12.5549],[-6.211,12.6049],[-6.004,12.6359],[-5.9811,12.6729],[-5.896,12.6519],[-5.579,12.8169],[-5.434,12.607],[-5.269,12.7959],[-5.145,12.744],[-5.065,12.5749],[-4.776,12.623],[-4.6911,12.7399],[-4.629,12.7559],[-4.612,12.7029],[-4.465,12.7174],[-4.4644,12.7173]]'::jsonb),
  ('TOM', 'Timbuktu', 'RURAL', 20.04466, -3.58479,
   '[[-4.8216,24.9951],[0.0037,21.8489],[-0.2219,21.153],[-1.3208,20.2818],[-2.0434,19.9155],[-0.9643,19.0642],[-0.8852,18.9553],[-0.9347,17.8861],[-1.7069,17.5145],[-1.6085,17.0357],[-0.683,16.9329],[-0.71,16.6129],[-0.694,16.047],[-0.5003,15.0797],[-0.7713,15.0566],[-1.214,15.1789],[-1.386,15.322],[-1.686,15.4309],[-1.989,15.4279],[-2.147,15.4069],[-2.4501,15.304],[-2.532,15.322],[-2.597,15.3689],[-2.772,15.7169],[-2.924,15.8539],[-3.156,15.8329],[-3.1641,15.8779],[-3.202,15.8949],[-3.33,15.7709],[-3.4211,15.7729],[-3.4821,15.7329],[-3.49,15.6],[-3.642,15.4909],[-3.845,15.4939],[-3.869,15.672],[-3.955,15.735],[-3.983,15.825],[-4.1351,15.8099],[-4.239,15.7189],[-4.377,15.7049],[-4.688,15.581],[-5.151,15.6089],[-5.23,15.674],[-5.3571,15.553],[-5.5088,15.5069],[-5.3533,16.312],[-5.6233,16.5278],[-6.5931,24.9941],[-5.0431,24.9949],[-4.8216,24.9951]]'::jsonb);

-- Las tres de la prueba quedan fuera del mapa, pero no se borran: su historial
-- —visitas, objetivos, puntos— está atado a ellas, y borrar la fila se lleva
-- todo eso por delante.
UPDATE com_zonas
   SET is_active = FALSE,
       notes = 'Zona de prueba. No es una demarcación real de Mali.'
 WHERE code IN ('DKR', 'THS') AND latitude IS NULL;

-- Y se avisa de lo que se acaba de hacer, que es la clase de cosa que se
-- descubre tres meses después.
DO $$
DECLARE v_prueba INTEGER; v_regiones INTEGER;
BEGIN
  SELECT count(*) INTO v_prueba FROM com_zonas WHERE is_active = FALSE AND latitude IS NULL;
  SELECT count(*) INTO v_regiones FROM com_zonas WHERE latitude IS NOT NULL;
  RAISE NOTICE 'com_zonas: % regiones reales con polígono, % zonas de prueba desactivadas', v_regiones, v_prueba;
END $$;

-- ─── 2 · UN COMERCIAL EN VARIAS ZONAS ──────────────────────────────────────
--
-- Antes `com_perfiles.home_zona_id` es un único entero: un comercial, una
-- zona. Eso no vale para Mali, donde un comercial de Bamako cubre Sego y
-- Koulikoro.
--
-- NO se cambia `home_zona_id`: es la zona PRINCIPAL y sigue valiendo, porque
-- el ranking y las consultas ya la usan. Se AÑADE una tabla de varias, y
-- `home_zona_id` pasa a ser «la primera de ellas», no la única.
--
-- Aquí NO hay clave foránea contra `customers`. Es lo mismo que en la 027: el
-- módulo no ata al ERP, para que el ERP no pueda bloquearse por un comercial.

CREATE TABLE com_comercial_zonas (
  comercial_id INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  zona_id      INTEGER NOT NULL REFERENCES com_zonas(id) ON DELETE CASCADE,
  -- La principal es la que sale marcada en el mapa y en la ficha.
  es_principal  BOOLEAN NOT NULL DEFAULT FALSE,
  -- El reparto de la zona entre los que la cubren. 100 con dos comerciales
  -- significa «a medias», y está bien: nadie tiene por qué llevar el 100 %.
  porcentaje     NUMERIC(5,2) CHECK (porcentaje IS NULL OR porcentaje BETWEEN 0 AND 100),
  desde          DATE NOT NULL DEFAULT CURRENT_DATE,
  hasta          DATE,
  notas          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT com_cz_periodo_valido CHECK (hasta IS NULL OR hasta >= desde),
  -- Un comercial no lleva dos veces la misma zona, aunque lo cubre en dos
  -- etapas: para eso está `desde`.
  CONSTRAINT uniq_comercial_zona UNIQUE (comercial_id, zona_id, desde)
);

CREATE INDEX idx_com_comercial_zonas_zona ON com_comercial_zonas(zona_id);
CREATE INDEX idx_com_comercial_zonas_vivas ON com_comercial_zonas(comercial_id)
  WHERE hasta IS NULL;

-- Una sola zona principal por comercial. No es «no puede haber dos», es
-- «no puede haber cero ni varias»: sin principal no se sabe cuál sale
-- marcada en el mapa, y con dos el mapa dice una cosa y la ficha otra.
CREATE UNIQUE INDEX uniq_comercial_zona_principal
  ON com_comercial_zonas(comercial_id) WHERE es_principal;

-- Y una zona principal por zona tampoco: la zona tiene UN responsable. Los
-- demás la cubren.
CREATE UNIQUE INDEX uniq_zona_responsable
  ON com_comercial_zonas(zona_id) WHERE es_principal;

-- ─── 3 · OBJETIVOS POR ZONA, SEPARADOS DE LOS DEL COMERCIAL ────────────────
--
-- `com_objetivos` es POR COMERCIAL y es de la 027: no se toca. Este es otro,
-- por zona. No se fusionan porque no siempre miden lo mismo: el objetivo del
-- comercial es el suyo, y el de la zona es el de la zona. Un comercial puede
-- tener los dos, y el de la zona se reparte entre los que la cubren según su
-- `porcentaje`.
--
-- Cuando la zona tiene comercial con `porcentaje` NULL, se reparte a partes
-- iguales. Es una convención, y por eso está en la función y no repartida por
-- la base: para que se pueda cambiar sin tocar datos.

CREATE TABLE com_objetivos_zona (
  id            SERIAL PRIMARY KEY,
  zona_id       INTEGER NOT NULL REFERENCES com_zonas(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  target_amount NUMERIC(18,2) CHECK (target_amount IS NULL OR target_amount >= 0),
  target_units  NUMERIC(18,2) CHECK (target_units  IS NULL OR target_units  >= 0),
  notas         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT com_obj_zona_periodo_valido CHECK (period_end >= period_start),
  CONSTRAINT com_obj_zona_no_vacio CHECK (
    target_amount IS NOT NULL OR target_units IS NOT NULL
  )
);

-- Una zona, un objetivo por periodo.
CREATE UNIQUE INDEX uniq_com_objetivo_zona_periodo
  ON com_objetivos_zona(zona_id, period_start);

CREATE INDEX idx_com_objetivos_zona_periodo ON com_objetivos_zona(period_start, period_end);

-- ─── 4 · LO QUE SE HA VENDIDO EN UNA ZONA ──────────────────────────────────
--
-- Se lee `customers.zone_id`, que es un id de la tabla `zones` DEL ERP. Las
-- zonas comerciales de aquí son las mismas nueve demarcaciones, y el puente
-- entre las dos tablas es el CÓDIGO: `zones.code` y `com_zonas.code` llevan
-- los mismos valores porque son las mismas demarcaciones.
--
-- Es el mismo criterio que el de la 027: se LEE, nunca se escribe. Por eso no
-- hay clave foránea de una a otra: si mañana el ERP renombra `BKO`, esta
-- función no lo rompe, simplemente no encuentra la zona y dice que no ha
-- encontrado nada.
--
-- Y por eso el comercial asignado a la zona no se mira `home_zona_id` sino la
-- tabla de varias: un comercial que cubre Koulikoro y Kayes tiene que contar
-- en las dos.

CREATE OR REPLACE FUNCTION com_hechos_zona(p_zona_id INT, p_desde DATE, p_hasta DATE)
RETURNS TABLE (
  importe NUMERIC, pedidos BIGINT, unidades NUMERIC,
  clientes_activos BIGINT, clientes_totales BIGINT,
  visitas BIGINT, nuevos_clientes BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH z AS (
    SELECT cz.code AS codigo FROM com_zonas cz WHERE cz.id = p_zona_id
  )
  SELECT
    COALESCE((
      SELECT SUM(so.total) FROM sales_orders so
        JOIN customers c ON c.id = so.customer_id
       WHERE c.zone_id IN (SELECT erp.id FROM zones erp JOIN z ON erp.code = z.codigo)
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM sales_orders so
        JOIN customers c ON c.id = so.customer_id
       WHERE c.zone_id IN (SELECT erp.id FROM zones erp JOIN z ON erp.code = z.codigo)
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT SUM(l.qty) FROM sales_order_lines l
        JOIN sales_orders so ON so.id = l.sales_order_id
        JOIN customers c ON c.id = so.customer_id
       WHERE c.zone_id IN (SELECT erp.id FROM zones erp JOIN z ON erp.code = z.codigo)
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(DISTINCT so.customer_id) FROM sales_orders so
        JOIN customers c ON c.id = so.customer_id
       WHERE c.zone_id IN (SELECT erp.id FROM zones erp JOIN z ON erp.code = z.codigo)
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM customers c
       WHERE c.zone_id IN (SELECT erp.id FROM zones erp JOIN z ON erp.code = z.codigo)
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM com_visitas v
        JOIN customers c ON c.id = v.customer_id
       WHERE c.zone_id IN (SELECT erp.id FROM zones erp JOIN z ON erp.code = z.codigo)
         AND v.visita_fecha BETWEEN p_desde AND p_hasta
    ), 0),
    -- «Nuevo» es nuevo PARA ESTA ZONA en este periodo: primer pedido con esa
    -- fecha. Un cliente que ya compraba antes no cuenta como nuevo por volver
    -- a comprar, que es el error más fácil de cometer al contar esto.
    COALESCE((
      SELECT COUNT(*) FROM (
        SELECT c.id,
               MIN(so.order_date) AS primera
          FROM customers c
          JOIN sales_orders so ON so.customer_id = c.id AND so.status <> 'CANCELLED'
         WHERE c.zone_id IN (SELECT erp.id FROM zones erp JOIN z ON erp.code = z.codigo)
         GROUP BY c.id
      ) t
      WHERE t.primera BETWEEN p_desde AND p_hasta
    ), 0);
$$;

-- ─── 5 · LA FICHA DE ZONA ──────────────────────────────────────────────────
--
-- El `tiene_objetivo` y el `cumplimiento_pct` con la misma regla que el
-- ranking de comerciales: sin objetivo, NULL y guion. Un 0 % y un guion son
-- cosas distintas, y en un mapa además se ven de lejos: un mapa lleno de
-- ceros parece un mapa donde nadie trabaja.
--
CREATE OR REPLACE VIEW com_ficha_zona AS
--
-- SIN UN CTE INTERMEDIO, A PROPÓSITO.
--
-- La primera versión hacía `LEFT JOIN periodo ON TRUE`, y eso es un PRODUCTO
-- CARTESIANO: cada zona se emparejaba con CADA objetivo que hubiera. Con un
-- solo objetivo puesto, Kidal salía con el objetivo de Gao y se enseñaba como
-- si tuviera objetivo propio y 999.999 FCFA.
--
-- Eliones directo por `zona_id`. Es lo mismo que seemedito con un CTE y encima
-- delata antes: un producto cartesiano con un solo objetivo es indistinguible
-- del correcto cuando solo hay uno.
--
SELECT
  z.id AS zona_id,
  z.code,
  z.name,
  z.kind,
  z.latitude,
  z.longitude,
  -- ¿Falta alguno de los cuatro datos de potencial? Es un aviso para la
  -- pantalla, no una regla: mientras falten, el resto de la ficha se calcula
  -- igual y no se inventa ningún número.
  (z.poblacion IS NULL OR z.clientes_potenciales IS NULL
   OR z.comercios_estimados IS NULL OR z.dificultad IS NULL) AS potencial_pendiente,
  z.poblacion,
  z.comercios_estimados,
  z.clientes_potenciales,
  z.dificultad,
  o.id IS NOT NULL AS tiene_objetivo,
  o.target_amount AS objetivo,
  o.target_units AS objetivo_unidades,
  h.importe,
  h.pedidos,
  h.unidades,
  h.clientes_activos,
  h.clientes_totales,
  h.visitas,
  h.nuevos_clientes,
  CASE WHEN o.id IS NOT NULL AND o.target_amount > 0
       THEN ROUND(h.importe / o.target_amount * 100, 1)
       ELSE NULL END AS cumplimiento_pct,
  (SELECT count(*) FROM com_comercial_zonas cz
    WHERE cz.zona_id = z.id AND cz.hasta IS NULL) AS comerciales_asignados,
  (SELECT COALESCE(json_agg(json_build_object(
              'comercial_id', cz.comercial_id,
              'nombre', u.full_name,
              'porcentaje', cz.porcentaje,
              'es_principal', cz.es_principal)
            ORDER BY cz.es_principal DESC, u.full_name), '[]'::json)
     FROM com_comercial_zonas cz
     JOIN com_perfiles cp ON cp.id = cz.comercial_id
     JOIN users u ON u.id = cp.user_id
    WHERE cz.zona_id = z.id AND cz.hasta IS NULL) AS comerciales
FROM com_zonas z
LEFT JOIN com_objetivos_zona o
  ON o.zona_id = z.id
 AND o.is_active
 AND CURRENT_DATE BETWEEN o.period_start AND o.period_end
CROSS JOIN LATERAL com_hechos_zona(
  z.id,
  COALESCE(o.period_start, date_trunc('month', CURRENT_DATE)::date),
  COALESCE(o.period_end, (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date)
) h
WHERE z.latitude IS NOT NULL;

-- ─── 6 · EL RANKING DE ZONAS ───────────────────────────────────────────────
--
-- Ordena por CUMPLIMIENTO, como el de comerciales, y por la misma razón: una
-- zona con el doble de población no puede quedar por debajo de otra por vender
-- menos euros. La pregunta es quién rinde más respecto a lo que se le pedía.
--
-- `tiene_potencial` va PRIMERO en el `CASE` del cumplimiento, no en la nota:
-- si el potencial no está puesto, el cumplimiento se calcula igual (el
-- objetivo es del objetivo) pero se marca para que la pantalla pueda
-- decirlo. NULL no fabrica nada; solo avisa de que falta un dato.
--
CREATE OR REPLACE VIEW com_ranking_zonas AS
SELECT
  f.*,
  DENSE_RANK() OVER (
    ORDER BY f.tiene_objetivo DESC,
             COALESCE(f.cumplimiento_pct, -1) DESC,
             f.importe DESC
  ) AS puesto,
  COUNT(*) OVER () AS zonas_en_lista,
  CASE WHEN NOT f.tiene_objetivo OR f.cumplimiento_pct IS NULL THEN '—'
       WHEN f.cumplimiento_pct = trunc(f.cumplimiento_pct)
            THEN f.cumplimiento_pct::bigint || ' %'
       ELSE f.cumplimiento_pct::text || ' %'
  END AS cumplimiento_texto,
  -- El crecimiento necesita dos periodos. Con uno solo no hay nada que
  -- comparar, y por eso sale NULL en vez de un 0 % que parece «no crece».
  NULL::NUMERIC AS crecimiento_pct
FROM com_ficha_zona f;
