/* eslint-disable @typescript-eslint/camelcase */
/* eslint-disable react/prop-types */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import React, { useState, useEffect, useCallback } from 'react';
import {
    IonCard,
    IonCardHeader,
    IonCardSubtitle,
    IonCardTitle,
    IonCardContent,
    IonInput,
    IonItem,
    IonLabel,
    IonButton,
    IonChip,
    IonLoading,
} from '@ionic/react';
import { DropdownOption } from '../DropdownOption';
import { btcDustyDurations, btcDurations } from '../../data/lockInfo';
import * as btcLock from '../../helpers/lockdrop/BitcoinLockdrop';
import { toast } from 'react-toastify';
//import BigNumber from 'bignumber.js';
import { makeStyles, createStyles } from '@material-ui/core';
import QrEncodedAddress from './QrEncodedAddress';
import * as bitcoinjs from 'bitcoinjs-lib';
import { OptionItem, Lockdrop, LockdropType } from 'src/types/LockdropModels';
import { ApiPromise } from '@polkadot/api';
import * as plasmUtils from '../../helpers/plasmUtils';
import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
import AppBtc from '@ledgerhq/hw-app-btc';
import TransportU2F from '@ledgerhq/hw-transport-u2f';
import { BlockStreamApi } from 'src/types/BlockStreamTypes';

interface Props {
    networkType: bitcoinjs.Network;
    plasmApi: ApiPromise;
}

const useStyles = makeStyles(() =>
    createStyles({
        button: {
            textAlign: 'center',
        },
    }),
);

const LedgerLock: React.FC<Props> = ({ networkType }) => {
    const classes = useStyles();

    const defaultPath = networkType === bitcoinjs.networks.bitcoin ? "m/44'/0'/0'" : "m/44'/1'/0'";
    // switch lock duration depending on the chain network
    const networkLockDur = networkType === bitcoinjs.networks.bitcoin ? btcDurations : btcDustyDurations;

    const [lockDuration, setDuration] = useState<OptionItem>({ label: '', value: 0, rate: 0 });
    const [p2shAddress, setP2sh] = useState('');
    const [allLockParams, setAllLockParams] = useState<Lockdrop[]>([]);
    const [currentScriptLocks, setCurrentScriptLocks] = useState<BlockStreamApi.Transaction[]>([]);
    const [btcApi, setBtcApi] = useState<AppBtc>();

    // changing the path to n/49'/x'/x' will return a signature error
    // this may be due to compatibility issues with BIP49
    const [addressPath, setAddressPath] = useState(defaultPath);
    const [isLoading, setLoading] = useState<{ loadState: boolean; message: string }>({
        loadState: false,
        message: '',
    });
    const [publicKey, setPublicKey] = useState('');

    const inputValidation = () => {
        if (lockDuration.value <= 0) {
            return { valid: false, message: 'Please provide a lock duration' };
        }

        return { valid: true, message: 'valid input' };
    };

    const ledgerApiInstance = async () => {
        if (btcApi === undefined) {
            try {
                const ts = await TransportWebUSB.create();
                const btc = new AppBtc(ts);
                setBtcApi(btc);
                return btc;
            } catch (e) {
                if (e.message === 'No device selected.') {
                    throw new Error(e);
                }
                console.log(e);
                console.log('failed to connect via WebUSB, trying U2F');
                try {
                    const ts = await TransportU2F.create();
                    const btc = new AppBtc(ts);
                    setBtcApi(btc);
                    return btc;
                } catch (err) {
                    console.log(err);
                    throw new Error(err);
                }
            }
        } else {
            return btcApi;
        }
    };

    const createLockAddress = async () => {
        if (!inputValidation().valid) {
            toast.error(inputValidation().message);
            return;
        }

        setLoading({ loadState: true, message: 'Waiting for Ledger' });

        try {
            const btc = await ledgerApiInstance();

            const wallet = await btc.getWalletPublicKey(addressPath, { format: 'p2sh' });
            const lockScript = btcLock.getLockP2SH(lockDuration.value, wallet.publicKey, networkType);
            console.log(wallet.publicKey);
            setPublicKey(wallet.publicKey);
            setP2sh(lockScript.address!);
            toast.success('Successfully created lock script');
        } catch (err) {
            toast.error(err.message);
            console.log(err);
        } finally {
            setLoading({
                loadState: false,
                message: '',
            });
        }
    };

    const unlockScriptTx = async (lock: BlockStreamApi.Transaction) => {
        setLoading({ loadState: true, message: 'Singing unlock script' });

        const lockScript = btcLock.getLockP2SH(lockDuration.value, publicKey, networkType);
        if (typeof lockScript.redeem !== 'undefined') {
            try {
                // get ledger API
                const btc = await ledgerApiInstance();

                // get transaction hex, we fetch it online because BlockStream does not provide one
                const rawTxHex = await btcLock.getTransactionHex(lock.txid, 'BTCTEST');

                /// method 1 ==============================
                const isSegWit = bitcoinjs.Transaction.fromHex(rawTxHex).hasWitnesses();
                const txIndex = 0; //temp value

                // transaction that locks the tokens
                const utxo = btc.splitTransaction(rawTxHex);

                const newTx = await btc.createPaymentTransactionNew({
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    inputs: [[utxo, txIndex, lockScript.redeem!.output!.toString('hex'), null]],
                    associatedKeysets: [addressPath],
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    outputScriptHex: lockScript.output!.toString('hex'),
                    segwit: isSegWit,
                    sigHashType: bitcoinjs.Transaction.SIGHASH_ALL,
                    lockTime: 0,
                    useTrustedInputForSegwit: isSegWit,
                });

                console.log(newTx);

                // method 2 ==============================
                const ledgerSigner = await btcLock.generateSigner(
                    btc,
                    addressPath,
                    networkType,
                    rawTxHex,
                    lockScript,
                    publicKey,
                );

                // this is used for the random output address
                const randomPublicKey = bitcoinjs.ECPair.makeRandom({ network: networkType, compressed: true })
                    .publicKey;
                const randomAddress = bitcoinjs.payments.p2pkh({ pubkey: randomPublicKey, network: networkType })
                    .address;
                const FEE = 1000;
                // create the redeem UTXO
                const unlockTx = await btcLock.btcUnlockTx(
                    ledgerSigner,
                    networkType,
                    bitcoinjs.Transaction.fromHex(rawTxHex),
                    lockScript.redeem!.output!,
                    btcLock.daysToBlockSequence(lockDuration.value),
                    randomAddress!,
                    FEE,
                );

                const signedTxHex = unlockTx.toHex();
                console.log(signedTxHex);
            } catch (err) {
                toast.error(err.message);
                console.log(err);
            } finally {
                setLoading({
                    loadState: false,
                    message: '',
                });
            }
        }
    };

    const fetchLockdropParams = useCallback(async () => {
        const blockStreamNet = networkType === bitcoinjs.networks.bitcoin ? 'mainnet' : 'testnet';
        // initialize lockdrop data array
        const _lockParams: Lockdrop[] = [];

        // get all the possible lock addresses
        networkLockDur.map(async (dur, index) => {
            const scriptAddr = btcLock.getLockP2SH(dur.value, publicKey, networkType).address!;

            // make a real-time lockdrop data structure with the current P2SH and duration
            const locks = await btcLock.getBtcTxsFromAddress(scriptAddr, blockStreamNet);
            console.log('fetching data from block stream');
            const daysToEpoch = 60 * 60 * 24 * dur.value;

            const lockParams = locks.map(i => {
                const lockVal = i.vout.find(locked => locked.scriptpubkey_address === scriptAddr);

                if (lockVal) {
                    return plasmUtils.createLockParam(
                        LockdropType.Bitcoin,
                        '0x' + i.txid,
                        '0x' + publicKey,
                        daysToEpoch.toString(),
                        lockVal.value.toString(),
                    );
                } else {
                    throw new Error('Could not find the lock value from the UTXO');
                }
            });

            // if the lock data is the one that the user is viewing
            if (p2shAddress === scriptAddr && dur.value === lockDuration.value) {
                setCurrentScriptLocks(locks);
            }

            // loop through all the token locks within the given script
            // this is to prevent nested array
            lockParams.forEach(e => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const currentParam = plasmUtils.structToLockdrop(e as any);

                _lockParams.push(currentParam);
            });

            // set lockdrop param data if we're in the final loop
            // we do this because we want to set the values inside the then block
            if (_lockParams.length > allLockParams.length && index === networkLockDur.length - 1) {
                setAllLockParams(_lockParams);
            }
        });
    }, [publicKey, networkType, p2shAddress, networkLockDur, allLockParams, lockDuration.value]);

    useEffect(() => {
        // change P2SH if the user changed the lock duration
        if (publicKey && p2shAddress) {
            const lockScript = btcLock.getLockP2SH(lockDuration.value, publicKey, networkType);
            setP2sh(lockScript.address!);
        }
        publicKey &&
            fetchLockdropParams().catch(e => {
                toast.error(e);
            });
    }, [fetchLockdropParams, lockDuration.value, networkType, publicKey, p2shAddress]);

    // fetch lock data in the background
    useEffect(() => {
        const interval = setInterval(async () => {
            publicKey &&
                fetchLockdropParams().catch(e => {
                    toast.error(e);
                });
        }, 5 * 1000);

        // cleanup hook
        return () => {
            clearInterval(interval);
        };
    });

    return (
        <div>
            {p2shAddress && (
                <QrEncodedAddress
                    address={p2shAddress}
                    lockData={currentScriptLocks}
                    onUnlock={unlockScriptTx}
                    lockDurationDay={lockDuration.value}
                />
            )}
            <IonLoading isOpen={isLoading.loadState} message={isLoading.message} />
            <IonCard>
                <IonCardHeader>
                    <IonCardSubtitle>
                        Please fill in the following form with the correct information. Your address path will default
                        to <code>{defaultPath}</code> if none is given. For more information, please check{' '}
                        <a
                            href="https://www.ledger.com/academy/crypto/what-are-hierarchical-deterministic-hd-wallets"
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            this page
                        </a>
                        . Regarding the audit by Quantstamp, click{' '}
                        <a
                            color="inherit"
                            href="https://github.com/staketechnologies/lockdrop-ui/blob/16a2d495d85f2d311957b9cf366204fbfabadeaa/audit/quantstamp-audit.pdf"
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            here
                        </a>{' '}
                        for details
                    </IonCardSubtitle>
                    <IonCardTitle>Sign Message</IonCardTitle>
                </IonCardHeader>

                <IonCardContent>
                    <IonLabel position="stacked">Bitcoin Address</IonLabel>
                    <IonItem>
                        <IonLabel position="floating">BIP32 Address Path</IonLabel>
                        <IonInput
                            placeholder={defaultPath}
                            onIonChange={e => setAddressPath(e.detail.value!)}
                        ></IonInput>
                    </IonItem>

                    <IonLabel position="stacked">Lock Duration</IonLabel>
                    <IonItem>
                        <DropdownOption
                            dataSets={networkLockDur}
                            onChoose={(e: React.ChangeEvent<HTMLInputElement>) =>
                                setDuration(
                                    networkLockDur.filter(i => i.value === ((e.target.value as unknown) as number))[0],
                                )
                            }
                        ></DropdownOption>
                        <IonChip>
                            <IonLabel>
                                {lockDuration.value
                                    ? 'The rate is ' + lockDuration.rate + 'x'
                                    : 'Please choose the duration'}
                            </IonLabel>
                        </IonChip>
                    </IonItem>
                    <div className={classes.button}>
                        <IonButton onClick={() => createLockAddress()} disabled={p2shAddress !== ''}>
                            Generate Lock Script
                        </IonButton>
                    </div>
                </IonCardContent>
            </IonCard>
        </div>
    );
};

export default LedgerLock;
